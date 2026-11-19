/**
 * P4-08 (ADR-127 §4, P4-01 security review): outbound connections of the
 * A2A client — every request this Daisy (or P4-09's standalone MCP) makes
 * to another Daisy's address goes through `outboundRequest`.
 *
 * An address in someone's identity card is text that person wrote; the
 * connection must never become a way into this machine or its network:
 *
 * - The host is resolved first (`lookup`, all addresses). Loopback,
 *   unspecified, link-local, multicast, reserved / documentation ranges
 *   and the clouds' metadata addresses are refused for every address
 *   kind; a `relay` address also refuses private ranges (10/8,
 *   172.16/12, 192.168/16, 100.64/10, fc00::/7 …); a `direct` address may
 *   be private (组网, D-24) but never loopback or link-local. IPv4 inside
 *   IPv6 (mapped, compatible, NAT64, 6to4) is judged as the IPv4 it
 *   carries. A name with any refused address is refused as a whole.
 * - The connection goes to the address that was checked (pinned): no
 *   second lookup between check and connect, so DNS rebinding cannot
 *   swap it. `Host` / SNI still carry the name.
 * - Plain `http` only to a private address (the token and the content
 *   would otherwise cross the internet in clear); `relay` only over https.
 * - TLS: a certificate a public CA vouches for (for that name) passes;
 *   anything else is up to `tlsCheck` (Daisy pins a self-signed
 *   certificate on first use, outgoing.ts). P5-02: with `binding` (a relay
 *   address: always), neither counts — the connection is taken only when
 *   the other Daisy's TLS binding claim, signed with its identity key,
 *   names the key this certificate carries (binding.ts; a relay operator
 *   can get a CA certificate for the subdomain, it cannot sign the claim).
 *   No byte of the request is written before that decision.
 * - Redirects are never followed (a 3xx is an error); the answer is capped
 *   in bytes and the whole exchange in time.
 *
 * Self-contained (node:* only): shared with P4-09's standalone MCP
 * (ADR-128; moved here from packages/daisy/src/a2a/client/).
 */
import { KeyedError, pt } from "../../contracts/src/i18n-process.ts";
import type { MessageKey } from "../../contracts/src/i18n.ts";
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { connect as netConnect, isIP, type Socket } from "node:net";
import { connect as tlsConnect, rootCertificates, type TLSSocket } from "node:tls";
import { createHash } from "node:crypto";
import { spkiHashOfCert } from "./binding.ts";

/** identity-card.md §1: how an address reaches the Daisy. */
export type AddrKind = "direct" | "relay";

export type AddressClass =
  | "loopback"
  | "unspecified"
  | "link-local"
  | "metadata"
  | "multicast"
  | "reserved"
  | "private"
  | "public";

/** Cloud metadata endpoints outside the link-local range, and the well-known ones inside it. */
const METADATA_V4 = new Set([
  "169.254.169.254", // AWS, GCP, Azure IMDS, OpenStack, DigitalOcean …
  "169.254.170.2", // AWS ECS task metadata
  "169.254.169.253", // AWS DNS
  "100.100.100.200", // Alibaba Cloud
  "168.63.129.16", // Azure wire server
  "192.0.0.192", // Oracle Cloud (old)
]);

function v4Bytes(s: string): number[] | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  const b = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  return b.every((x) => x >= 0 && x <= 255) ? b : null;
}

/** An IPv6 literal as 16 bytes (null when not one). Zone ids are refused by the caller. */
export function v6Bytes(s: string): number[] | null {
  if (isIP(s) !== 6) return null;
  let head = s.toLowerCase();
  // A trailing dotted IPv4 (::ffff:1.2.3.4).
  let tail: number[] = [];
  const dot = head.lastIndexOf(":");
  if (head.includes(".")) {
    const v4 = v4Bytes(head.slice(dot + 1));
    if (!v4) return null;
    tail = v4;
    head = head.slice(0, dot + 1) + "0:0";
  }
  const [l, r] = head.split("::") as [string, string | undefined];
  const left = l ? l.split(":") : [];
  const right = r !== undefined && r !== "" ? r.split(":") : [];
  const fill = 8 - left.length - right.length;
  const groups = r === undefined ? left : [...left, ...Array(fill).fill("0"), ...right];
  if (groups.length !== 8) return null;
  const out: number[] = [];
  for (const g of groups) {
    const n = parseInt(g || "0", 16);
    out.push((n >> 8) & 255, n & 255);
  }
  if (tail.length) out.splice(12, 4, ...tail);
  return out;
}

function classifyV4([a, b, c, d]: number[]): AddressClass {
  const s = `${a}.${b}.${c}.${d}`;
  if (METADATA_V4.has(s)) return "metadata";
  if (a === 0) return "unspecified";
  if (a === 127) return "loopback";
  if (a === 169 && b === 254) return "link-local";
  if (a! >= 224 && a! <= 239) return "multicast";
  if (a! >= 240) return "reserved"; // incl. 255.255.255.255
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return "reserved"; // IETF assignments, TEST-NET-1
  if (a === 198 && b === 51 && c === 100) return "reserved"; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return "reserved"; // TEST-NET-3
  if (a === 192 && b === 88 && c === 99) return "reserved"; // 6to4 relay anycast (deprecated)
  if (a === 10) return "private";
  if (a === 172 && b! >= 16 && b! <= 31) return "private";
  if (a === 192 && b === 168) return "private";
  if (a === 100 && b! >= 64 && b! <= 127) return "private"; // CGNAT / Tailscale (100.64/10)
  if (a === 198 && (b === 18 || b === 19)) return "private"; // benchmarking
  return "public";
}

/** What kind of address `ip` (a literal) is; null when it is not an IP literal. */
export function classifyAddress(ip: string): AddressClass | null {
  if (ip.includes("%")) return "reserved"; // a zone id: link-scoped
  const v4 = isIP(ip) === 4 ? v4Bytes(ip) : null;
  if (v4) return classifyV4(v4);
  const b = v6Bytes(ip);
  if (!b) return null;
  const zero = (from: number, to: number) => b.slice(from, to).every((x) => x === 0);
  if (zero(0, 16)) return "unspecified";
  if (zero(0, 15) && b[15] === 1) return "loopback";
  // IPv4-mapped ::ffff:a.b.c.d and IPv4-compatible ::a.b.c.d.
  if (zero(0, 10) && b[10] === 0xff && b[11] === 0xff) return classifyV4(b.slice(12));
  if (zero(0, 12)) return classifyV4(b.slice(12));
  // NAT64 64:ff9b::/96 (and the local-use 64:ff9b:1::/48).
  if (b[0] === 0 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) return classifyV4(b.slice(12));
  // 6to4 2002::/16 carries an IPv4 in bytes 2–5.
  if (b[0] === 0x20 && b[1] === 0x02) return classifyV4(b.slice(2, 6));
  // Teredo 2001::/32 (an obfuscated IPv4 inside): refused.
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0 && b[3] === 0) return "reserved";
  // Documentation 2001:db8::/32; discard 100::/64.
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return "reserved";
  if (b[0] === 0x01 && b[1] === 0x00 && zero(2, 8)) return "reserved";
  if (b[0] === 0xff) return "multicast";
  if (b[0] === 0xfe && (b[1]! & 0xc0) === 0x80) return "link-local";
  if (b[0] === 0xfe && (b[1]! & 0xc0) === 0xc0) return "private"; // site-local (deprecated)
  if ((b[0]! & 0xfe) === 0xfc) {
    // fd00:ec2::254 — AWS IMDS over IPv6.
    if (b[0] === 0xfd && b[1] === 0 && b[2] === 0x0e && b[3] === 0xc2 && zero(4, 14) && b[14] === 0x02 && b[15] === 0x54)
      return "metadata";
    return "private";
  }
  return "public";
}

/** Tests only: what createApp may relax (never set by main.ts). */
export interface OutboundPolicy {
  /** Tests only: two Daisies in one process talk over 127.0.0.1. Never loopback otherwise. */
  allowLoopback?: boolean;
  /** Tests: a resolver standing in for DNS. */
  lookup?: (host: string) => Promise<{ address: string; family: number }[]>;
  /**
   * Tests only (P5-02): a test CA trusted like a public one — so the
   * malicious-relay simulation's certificate is "publicly trusted".
   */
  ca?: string;
}

/** Why an address may not be connected to, or null when it may. */
export function addressRefusal(cls: AddressClass, kind: AddrKind, policy: OutboundPolicy = {}): string | null {
  switch (cls) {
    case "public":
      return null;
    case "private":
      return kind === "relay" ? pt("a2a.net.refused.privateRelay") : null;
    case "loopback":
      return policy.allowLoopback ? null : pt("a2a.net.refused.loopback");
    case "unspecified":
      return pt("a2a.net.refused.unspecified");
    case "link-local":
      return pt("a2a.net.refused.linkLocal");
    case "metadata":
      return pt("a2a.net.refused.metadata");
    case "multicast":
      return pt("a2a.net.refused.multicast");
    case "reserved":
      return pt("a2a.net.refused.reserved");
  }
}

export type OutboundErrorCode =
  | "bad_url"
  | "refused_address"
  | "dns"
  | "connect"
  | "tls"
  | "timeout"
  | "redirect"
  | "too_large"
  | "protocol";

/** The connection was not made, or its answer not taken. `message` is safe to show (no secrets). */
export class OutboundError extends KeyedError {
  constructor(
    readonly code: OutboundErrorCode,
    key: MessageKey,
    params: Record<string, string | number> = {},
    /** The request may have reached the other side (a resend must be idempotent). */
    readonly maybeDelivered = false,
  ) {
    super(key, params);
  }
}

/** What a TLS connection showed, for `tlsCheck`. */
export interface TlsSeen {
  /** `https://host:port` as asked for. */
  origin: string;
  /** SHA-256 of the leaf certificate (DER), lower-case hex. */
  fingerprint: string;
  /** A CA this machine trusts vouches for it, for this name. */
  authorized: boolean;
  /** P5-02: SHA-256 of the certificate's SubjectPublicKeyInfo (DER), base64url (binding.ts). */
  spki: string;
}

export interface OutboundRequest {
  url: string;
  kind: AddrKind;
  method: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  timeoutMs: number;
  maxBytes: number;
  policy?: OutboundPolicy;
  /**
   * A certificate no CA vouches for: accept (true) or refuse (the message).
   * Absent: only CA-verified certificates are accepted.
   */
  tlsCheck?: (seen: TlsSeen) => true | string;
  /**
   * P5-02: the TLS binding claim decides (binding.ts) — `true`, or why not.
   * When given, `authorized` and `tlsCheck` are not consulted: a CA's word
   * is not enough where the relay could have asked a CA.
   */
  binding?: (seen: TlsSeen) => Promise<true | string>;
}

export interface OutboundResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
  /** The address connected to (pinned). */
  address: string;
}

const defaultLookup = (host: string) => dnsLookup(host, { all: true, verbatim: true });

/** Parse and check a URL this client may call (http / https, no credentials, no fragment). */
export function outboundUrl(raw: string, kind: AddrKind): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new OutboundError("bad_url", "a2a.net.badUrl");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new OutboundError("bad_url", "a2a.net.httpOnly");
  if (kind === "relay" && u.protocol !== "https:") throw new OutboundError("bad_url", "a2a.net.relayHttps");
  if (u.username || u.password) throw new OutboundError("bad_url", "a2a.net.userinfo");
  if (u.hash) throw new OutboundError("bad_url", "a2a.net.hash");
  return u;
}

/** Resolve `host` and choose the address to connect to (all must pass). */
export async function resolveChecked(
  host: string,
  kind: AddrKind,
  plainHttp: boolean,
  policy: OutboundPolicy = {},
): Promise<string> {
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  let addrs: string[];
  if (isIP(bare)) addrs = [bare];
  else {
    if (!/^[a-z0-9.-]+$/i.test(bare) || bare.length > 253) throw new OutboundError("bad_url", "a2a.net.badHost");
    try {
      addrs = (await (policy.lookup ?? defaultLookup)(bare)).map((a) => a.address);
    } catch {
      throw new OutboundError("dns", "a2a.net.noHost", { host: bare.slice(0, 80) });
    }
    if (!addrs.length) throw new OutboundError("dns", "a2a.net.noHost", { host: bare.slice(0, 80) });
  }
  for (const a of addrs) {
    const cls = classifyAddress(a);
    if (!cls) throw new OutboundError("refused_address", "a2a.net.notIp");
    const why = addressRefusal(cls, kind, policy);
    if (why) throw new OutboundError("refused_address", "a2a.net.refusedAddress", { host: bare.slice(0, 80), why });
    // Plain http only inside a private network (or the tests' loopback).
    if (plainHttp && cls === "public")
      throw new OutboundError("refused_address", "a2a.net.plainHttpPublic", { host: bare.slice(0, 80) });
  }
  return addrs[0]!;
}

function connectPinned(
  u: URL,
  address: string,
  deadline: number,
  tlsCheck: OutboundRequest["tlsCheck"],
  binding?: OutboundRequest["binding"],
  ca?: string,
): Promise<Socket> {
  const port = Number(u.port) || (u.protocol === "https:" ? 443 : 80);
  const host = u.hostname.startsWith("[") ? u.hostname.slice(1, -1) : u.hostname;
  return new Promise<Socket>((resolve, reject) => {
    let done = false;
    const fail = (e: OutboundError) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      reject(e);
    };
    const timer = setTimeout(
      () => fail(new OutboundError("timeout", "a2a.net.connectTimeout")),
      Math.max(1, deadline - Date.now()),
    );
    let sock: Socket;
    if (u.protocol === "https:") {
      const t: TLSSocket = tlsConnect({
        host: address,
        port,
        ...(isIP(host) ? {} : { servername: host }),
        // Checked below, before anything is written.
        rejectUnauthorized: false,
        ...(ca ? { ca: [...rootCertificates, ca] } : {}),
        minVersion: "TLSv1.2",
        ALPNProtocols: ["http/1.1"],
      });
      sock = t;
      t.once("secureConnect", () => {
        if (done) return;
        const cert = t.getPeerCertificate();
        const x509 = t.getPeerX509Certificate();
        if (!cert || !cert.raw || !x509) return fail(new OutboundError("tls", "a2a.net.noCertificate"));
        const seen: TlsSeen = {
          origin: `https://${u.host}`,
          fingerprint: createHash("sha256").update(cert.raw).digest("hex"),
          authorized: t.authorized,
          spki: spkiHashOfCert(x509),
        };
        const take = () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve(t);
        };
        if (binding) {
          // Nothing is written on this socket until the claim says yes.
          binding(seen).then(
            (verdict) => (verdict === true ? take() : fail(new OutboundError("tls", "a2a.net.tlsRefused", { why: verdict }))),
            () => fail(new OutboundError("tls", "a2a.net.bindingUnchecked")),
          );
          return;
        }
        if (!seen.authorized) {
          const verdict = tlsCheck ? tlsCheck(seen) : pt("a2a.net.untrusted");
          if (verdict !== true) return fail(new OutboundError("tls", "a2a.net.tlsRefused", { why: verdict }));
        }
        take();
      });
    } else {
      sock = netConnect({ host: address, port });
      sock.once("connect", () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(sock);
      });
    }
    sock.once("error", () => fail(new OutboundError("connect", "a2a.net.connectFailed", { host: u.host.slice(0, 80) })));
  });
}

/** One request, as described in the module comment. */
export async function outboundRequest(o: OutboundRequest): Promise<OutboundResponse> {
  const u = outboundUrl(o.url, o.kind);
  const deadline = Date.now() + o.timeoutMs;
  const address = await resolveChecked(u.hostname, o.kind, u.protocol === "http:", o.policy);
  const sock = await connectPinned(u, address, deadline, o.tlsCheck, o.binding, o.policy?.ca);
  return new Promise<OutboundResponse>((resolve, reject) => {
    let settled = false;
    let sent = false;
    const fail = (e: OutboundError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.destroy();
      sock.destroy();
      reject(e);
    };
    const timer = setTimeout(
      () => fail(new OutboundError("timeout", "a2a.net.answerTimeout", {}, sent)),
      Math.max(1, deadline - Date.now()),
    );
    const port = Number(u.port) || (u.protocol === "https:" ? 443 : 80);
    const body = o.body === undefined ? undefined : Buffer.from(o.body, "utf8");
    const req = httpRequest({
      method: o.method,
      path: u.pathname + u.search,
      // The guard on the other side checks Host against its face's names (port included).
      headers: {
        ...o.headers,
        host: `${u.hostname}:${port}`,
        ...(body ? { "content-length": String(body.length) } : {}),
      },
      createConnection: () => sock,
    });
    req.on("error", () => fail(new OutboundError("connect", "a2a.net.connectionLost", {}, sent)));
    req.on("response", (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        res.resume();
        return fail(new OutboundError("redirect", "a2a.net.redirect", { status }, true));
      }
      const declared = Number(res.headers["content-length"]);
      if (Number.isFinite(declared) && declared > o.maxBytes) {
        res.resume();
        return fail(new OutboundError("too_large", "a2a.net.tooLarge", { max: o.maxBytes }, true));
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (c: Buffer) => {
        size += c.length;
        if (size > o.maxBytes) return fail(new OutboundError("too_large", "a2a.net.tooLarge", { max: o.maxBytes }, true));
        chunks.push(c);
      });
      res.on("end", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        sock.destroy();
        resolve({ status, headers: res.headers, body: Buffer.concat(chunks), address });
      });
      res.on("error", () => fail(new OutboundError("connect", "a2a.net.lostWhileReading", {}, true)));
    });
    req.end(body, () => {
      sent = true;
    });
  });
}
