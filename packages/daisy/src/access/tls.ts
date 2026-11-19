/**
 * P1-03 (D-31, ADR-101): the outside face's TLS by default — a
 * self-signed certificate made on first use (node-forge; Node's crypto
 * cannot write X.509) with an RSA-2048 key from node:crypto. Certificate
 * and key live in keys/ (0600). The browser warns once about a
 * self-signed certificate; a CA certificate is stage 5 (ADR-100).
 *
 * P6-15 (ADR-158): a new certificate breaks every first-use pin (paired
 * devices, A2A callers that pinned it), so one is made only for the
 * documented reasons — none yet (`missing`), it does not cover the host
 * (`host`), it runs out within a day (`expiring`) — and each time said in
 * the log and the audit (reason, host, the new fingerprint; never the key).
 * Anything else wrong with the files (a key readable by others is
 * tightened when it is ours; a foreign owner, a link, an empty or broken
 * file, a key that does not match) refuses the outside face with what to
 * do instead of quietly making a new pair. The certificate's SHA-256 (DER,
 * colon hex — what openssl and the browser show) is what the owner
 * compares (`daisy access show`, `daisy pair`, the settings page).
 */
import { ownerT } from "../platform/language.ts";
import { createPublicKey, generateKeyPairSync, X509Certificate } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { isIP } from "node:net";
import { join } from "node:path";
import forge from "node-forge";
import { COMMAND_NAME } from "../../../contracts/src/names.ts";
import { log } from "../observe/log.ts";
import { readSecretFile } from "./secret-file.ts";
import { ensureKeysDir, writeSecret } from "./keys.ts";

/** There at all — a link counts, even a dangling one (review L4: refused below, never written over). */
const present = (p: string) => {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

export function tlsFiles(dataDir: string) {
  return {
    cert: join(dataDir, "keys", "tls-cert.pem"),
    key: join(dataDir, "keys", "tls-key.pem"),
  };
}

/** Why a new certificate was made — the only reasons there are. */
export type TlsReason = "missing" | "host" | "expiring";
/** For the log (plain English). */
export const TLS_REASON: Record<TlsReason, string> = {
  missing: "no certificate yet (the outside face's first start, or the certificate / key file is gone)",
  host: "the old certificate does not cover the listening address",
  expiring: "the old certificate expires within a day",
};

export interface TlsMaterial {
  cert: string;
  key: string;
  /** SHA-256 of the certificate (DER), colon hex: what openssl and the browser show. */
  fingerprint: string;
  /** Set when this call made a new certificate. */
  generated?: { reason: TlsReason; detail: string };
}

/** The certificate files cannot be used and must not be replaced quietly. */
export class TlsRefused extends Error {
  /** Review L5: the short reason an answer may carry (no paths, no uids); the message (with them) is for the log. */
  reason: string;
  constructor(message: string, reason: string) {
    super(message);
    this.name = "TlsRefused";
    this.reason = reason;
  }
}
/** P6-23b: TlsRefused's texts are the owner's (start problems, the answer's reason), in the owner's language. */
const tl = (key: string, params?: Record<string, unknown>) => ownerT().dynamic(`server-access.tls.${key}`, params);
const short = (what: string) => tl("short", { what: tl(`short.${what}`) });

/** SHA-256 of a PEM certificate's DER, `AB:CD:…` (openssl x509 -fingerprint -sha256; the browser's viewer). */
export function certFingerprint(pem: string): string {
  return new X509Certificate(pem).fingerprint256;
}

/** The outside face's current certificate fingerprint, or null (none yet, unreadable). Reads only. */
export function currentFingerprint(dataDir: string): string | null {
  try {
    return certFingerprint(readFileSync(tlsFiles(dataDir).cert, "utf8"));
  } catch {
    return null;
  }
}

const redo = (f: string) => tl("redo", { file: f });

/**
 * A file of the pair as it should be: a regular file of ours. Group /
 * other bits on it are taken off (through the opened descriptor, never
 * following a link) and said in the log; anything else refuses.
 */
function tighten(path: string, uid: number | undefined) {
  if (process.platform === "win32") return; // the keys/ folder's DACL (ensureKeysDir)
  const st = lstatSync(path);
  if (st.isSymbolicLink()) throw new TlsRefused(tl("symlink", { file: path, redo: redo(path) }), short("symlink"));
  if (!st.isFile()) throw new TlsRefused(tl("notFile", { file: path, redo: redo(path) }), short("notFile"));
  if ((st.mode & 0o077) === 0) return;
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const now = fstatSync(fd);
    if (!now.isFile()) throw new TlsRefused(tl("notFile", { file: path, redo: redo(path) }), short("notFile"));
    if (uid !== undefined && now.uid !== uid)
      throw new TlsRefused(
        tl("otherOwner", { file: path, uid: now.uid, own: uid, redo: redo(path) }),
        short("otherOwner"),
      );
    const was = now.mode & 0o777;
    fchmodSync(fd, was & 0o700);
    log.warn(`Outside face certificate file ${path} had mode ${was.toString(8).padStart(4, "0")} (readable by other accounts), tightened to ${(was & 0o700).toString(8).padStart(4, "0")}; the certificate was not changed`);
  } finally {
    closeSync(fd);
  }
}

/**
 * The outside face's certificate and key for `host`: the ones in keys/
 * when they cover it; a new pair only for a TlsReason. Throws TlsRefused
 * when the files are there but cannot be used.
 */
export function tlsMaterial(dataDir: string, host: string): TlsMaterial {
  ensureKeysDir(dataDir);
  const f = tlsFiles(dataDir);
  const uid = process.platform === "win32" ? undefined : process.getuid?.();
  const haveCert = present(f.cert),
    haveKey = present(f.key);
  let reason: TlsReason | null = null;
  let detail = "";
  if (!haveCert && !haveKey) reason = "missing";
  else if (!haveCert || !haveKey) {
    // One of the pair alone is no use (its other half is gone): said, then a new pair.
    reason = "missing";
    detail = `${haveCert ? f.key : f.cert} is gone`;
  } else {
    tighten(f.cert, uid);
    tighten(f.key, uid);
    let key: string;
    try {
      key = readSecretFile(f.key, uid);
    } catch (e) {
      throw new TlsRefused(tl("keyUnusable", { error: (e as Error).message, redo: redo(f.key) }), short("keyUnusable"));
    }
    const cert = readFileSync(f.cert, "utf8");
    let x: X509Certificate;
    try {
      x = new X509Certificate(cert);
    } catch (e) {
      throw new TlsRefused(tl("certUnreadable", { file: f.cert, error: (e as Error).message, redo: redo(f.cert) }), short("certUnreadable"));
    }
    let matches = false;
    try {
      const a = createPublicKey(key).export({ type: "spki", format: "der" }) as Buffer;
      const b = x.publicKey.export({ type: "spki", format: "der" }) as Buffer;
      matches = a.equals(b);
    } catch {}
    if (!matches) throw new TlsRefused(tl("mismatch", { key: f.key, cert: f.cert, redo: redo(f.key) }), short("mismatch"));
    const covers =
      host === "0.0.0.0" || host === "::" || (isIP(host) ? !!x.checkIP(host) : !!x.checkHost(host));
    if (!covers) {
      reason = "host";
      detail = `listening address ${host}`;
    } else if (!(Date.parse(x.validTo) > Date.now() + 86400_000)) {
      reason = "expiring";
      detail = `expires ${x.validTo}`;
    } else return { cert, key, fingerprint: x.fingerprint256 };
  }
  const made = generate(host);
  writeSecret(f.key, made.key);
  writeSecret(f.cert, made.cert);
  const fingerprint = certFingerprint(made.cert);
  log.warn(
    `Outside face: made a new self-signed certificate: ${TLS_REASON[reason]}${detail ? ` (${detail})` : ""}; new SHA-256 fingerprint ${fingerprint} (${COMMAND_NAME} access show prints it too)`,
  );
  return { ...made, fingerprint, generated: { reason, detail } };
}

function generate(host: string): { cert: string; key: string } {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const keyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const c = forge.pki.createCertificate();
  c.publicKey = forge.pki.publicKeyFromPem(
    publicKey.export({ type: "spki", format: "pem" }).toString(),
  );
  c.serialNumber = "01" + forge.util.bytesToHex(forge.random.getBytesSync(15));
  c.validity.notBefore = new Date(Date.now() - 60_000);
  c.validity.notAfter = new Date(Date.now() + 397 * 86400_000);
  const attrs = [{ name: "commonName", value: host && host !== "0.0.0.0" ? host : "daisy" }];
  c.setSubject(attrs);
  c.setIssuer(attrs);
  const alt: any[] = [{ type: 7, ip: "127.0.0.1" }];
  if (host && host !== "0.0.0.0" && host !== "::" && host !== "127.0.0.1")
    alt.push(isIP(host) ? { type: 7, ip: host } : { type: 2, value: host });
  c.setExtensions([
    { name: "basicConstraints", cA: false },
    { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
    { name: "extKeyUsage", serverAuth: true },
    { name: "subjectAltName", altNames: alt },
  ]);
  c.sign(forge.pki.privateKeyFromPem(keyPem), forge.md.sha256.create());
  return { cert: forge.pki.certificateToPem(c), key: keyPem };
}
