/**
 * P5-01 (ADR-100 A1, ADR-143 §3): read the server name (SNI, RFC 6066 §3)
 * out of a TLS ClientHello without terminating TLS. Pure: bytes in, an
 * answer out. Everything is bounded — the relay calls it with what has
 * arrived so far and gives up past `maxBytes`.
 *
 * Accepted: handshake records (type 22, version 3.x, 1..16384 bytes each)
 * whose concatenated fragments start with one ClientHello (type 1); the
 * ClientHello may span records. Anything else is `bad`. The relay never
 * answers a `bad` hello with TLS: it closes.
 */

export type HelloResult = { state: "need" } | { state: "ok"; sni: string | null } | { state: "bad"; reason: string };

const REC_HANDSHAKE = 22;
const HS_CLIENT_HELLO = 1;
const EXT_SERVER_NAME = 0;
const MAX_RECORD = 16384;

const bad = (reason: string): HelloResult => ({ state: "bad", reason });

/** A DNS host name as SNI carries it: ASCII letters, digits, hyphens, dots; no trailing dot. */
const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

export function parseClientHello(buf: Uint8Array, maxBytes: number): HelloResult {
  // 1. Reassemble the handshake fragments from the records seen so far.
  const frags: Uint8Array[] = [];
  let hsLen = 0;
  let off = 0;
  let need: number | null = null; // the whole ClientHello's length once known
  while (true) {
    if (need !== null && hsLen >= 4 + need) break;
    if (buf.length - off < 5) return buf.length > maxBytes ? bad("too_big") : { state: "need" };
    const type = buf[off]!;
    const major = buf[off + 1]!;
    const len = (buf[off + 3]! << 8) | buf[off + 4]!;
    if (type !== REC_HANDSHAKE) return bad("not_handshake");
    if (major !== 3) return bad("not_tls");
    if (len === 0 || len > MAX_RECORD) return bad("record_length");
    if (off + 5 + len > maxBytes) return bad("too_big");
    if (buf.length - off - 5 < len) return { state: "need" };
    frags.push(buf.subarray(off + 5, off + 5 + len));
    hsLen += len;
    off += 5 + len;
    if (need === null && hsLen >= 4) {
      const head = concat(frags, 4);
      if (head[0] !== HS_CLIENT_HELLO) return bad("not_client_hello");
      need = (head[1]! << 16) | (head[2]! << 8) | head[3]!;
      if (need + 4 > maxBytes) return bad("too_big");
    }
  }
  const hs = concat(frags, 4 + need!);
  return readHello(hs.subarray(4));
}

function concat(parts: Uint8Array[], n: number): Uint8Array {
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    if (o >= n) break;
    const take = Math.min(p.length, n - o);
    out.set(p.subarray(0, take), o);
    o += take;
  }
  return out;
}

/** The ClientHello body (RFC 8446 §4.1.2; TLS 1.2 is the same shape). */
function readHello(b: Uint8Array): HelloResult {
  let o = 0;
  const has = (n: number) => o + n <= b.length;
  const u8 = () => b[o++]!;
  const u16 = () => {
    const v = (b[o]! << 8) | b[o + 1]!;
    o += 2;
    return v;
  };
  if (!has(2 + 32 + 1)) return bad("short");
  if (b[0] !== 3) return bad("not_tls");
  o += 2 + 32; // legacy_version, random
  const sid = u8();
  if (sid > 32 || !has(sid)) return bad("session_id");
  o += sid;
  if (!has(2)) return bad("short");
  const cs = u16();
  if (cs < 2 || cs % 2 !== 0 || !has(cs)) return bad("cipher_suites");
  o += cs;
  if (!has(1)) return bad("short");
  const comp = u8();
  if (comp < 1 || !has(comp)) return bad("compression");
  o += comp;
  if (o === b.length) return { state: "ok", sni: null }; // no extensions at all
  if (!has(2)) return bad("short");
  const extLen = u16();
  if (o + extLen !== b.length) return bad("extensions_length");
  const seen = new Set<number>();
  let sni: string | null = null;
  while (o < b.length) {
    if (!has(4)) return bad("extension");
    const type = u16();
    const len = u16();
    if (!has(len)) return bad("extension");
    if (seen.has(type)) return bad("duplicate_extension");
    seen.add(type);
    if (type === EXT_SERVER_NAME) {
      const r = readServerName(b.subarray(o, o + len));
      if (typeof r !== "string") return r;
      sni = r;
    }
    o += len;
  }
  return { state: "ok", sni };
}

/** RFC 6066 §3: a list with exactly one host_name (type 0). */
function readServerName(e: Uint8Array): string | HelloResult {
  if (e.length < 2) return bad("server_name");
  const listLen = (e[0]! << 8) | e[1]!;
  if (listLen + 2 !== e.length) return bad("server_name");
  let o = 2;
  let host: string | null = null;
  while (o < e.length) {
    if (o + 3 > e.length) return bad("server_name");
    const nameType = e[o]!;
    const len = (e[o + 1]! << 8) | e[o + 2]!;
    o += 3;
    if (len === 0 || o + len > e.length) return bad("server_name");
    if (nameType === 0) {
      if (host !== null) return bad("server_name");
      const raw = e.subarray(o, o + len);
      for (const c of raw) if (c < 0x21 || c > 0x7e) return bad("server_name");
      const h = String.fromCharCode(...raw).toLowerCase();
      if (!HOST_RE.test(h)) return bad("server_name");
      host = h;
    }
    o += len;
  }
  if (host === null) return bad("server_name");
  return host;
}

/** A plaintext TLS alert record (fatal), sent before any ServerHello. */
export const alertRecord = (description: number) => Buffer.from([0x15, 0x03, 0x03, 0x00, 0x02, 0x02, description]);
