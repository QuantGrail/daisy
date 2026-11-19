/**
 * P5-02 (ADR-100 B1, ADR-144 §5): the X.509 pieces the relay address
 * needs with an ECDSA P-256 key — node:crypto signs and parses but cannot
 * write a certificate or a CSR, and node-forge writes only RSA ones. So the
 * structures are put together here with node-forge's ASN.1 / DER encoder
 * (no cryptography of our own: every signature is node:crypto's), and
 * checked by node:crypto's own X509Certificate and TLS in the tests.
 *
 * - the self-signed certificate for `<subdomain>.<relay domain>` (the
 *   fallback; also what serves until ACME succeeds);
 * - the PKCS#10 CSR sent to the ACME server (RFC 8555 §7.4);
 * - the TLS-ALPN-01 challenge certificate (RFC 8737 §3: the name, and the
 *   critical acmeIdentifier extension holding SHA-256 of the key
 *   authorization);
 * - the ARI certificate identifier (RFC 9773 §4.1).
 */
import { createHash, createPublicKey, generateKeyPairSync, randomBytes, sign, verify, X509Certificate, type KeyObject } from "node:crypto";
import forge from "node-forge";

const asn1 = forge.asn1;
/** Parse without guessing at BIT STRING contents: re-encoding then gives the same bytes. */
const NO_BITS = { decodeBitStrings: false } as any;
const U = asn1.Class.UNIVERSAL;
const T = asn1.Type;
type A = forge.asn1.Asn1;

const OID = {
  ecdsaSha256: "1.2.840.10045.4.3.2",
  rsaSha256: "1.2.840.113549.1.1.11",
  commonName: "2.5.4.3",
  subjectAltName: "2.5.29.17",
  basicConstraints: "2.5.29.19",
  keyUsage: "2.5.29.15",
  extKeyUsage: "2.5.29.37",
  serverAuth: "1.3.6.1.5.5.7.3.1",
  subjectKeyId: "2.5.29.14",
  authorityKeyId: "2.5.29.35",
  acmeIdentifier: "1.3.6.1.5.5.7.1.31",
  extensionRequest: "1.2.840.113549.1.9.14",
} as const;

const bin = (b: Uint8Array) => Buffer.from(b).toString("binary");
const der = (a: A) => Buffer.from(asn1.toDer(a).getBytes(), "binary");
const seq = (v: A[]) => asn1.create(U, T.SEQUENCE, true, v);
const set = (v: A[]) => asn1.create(U, T.SET, true, v);
const oid = (o: string) => asn1.create(U, T.OID, false, asn1.oidToDer(o).getBytes());
const octets = (b: Uint8Array) => asn1.create(U, T.OCTETSTRING, false, bin(b));
const bool = (v: boolean) => asn1.create(U, T.BOOLEAN, false, v ? "\xff" : "\x00");
const int = (b: Uint8Array) => asn1.create(U, T.INTEGER, false, bin(b));
const bits = (b: Uint8Array) => asn1.create(U, T.BITSTRING, false, "\x00" + bin(b));
const utf8 = (s: string) => asn1.create(U, T.UTF8, false, forge.util.encodeUtf8(s));
const explicit = (n: number, v: A[]) => asn1.create(asn1.Class.CONTEXT_SPECIFIC, n, true, v);

/** A positive INTEGER's content octets from random bytes (no leading 1 bit, no leading zero). */
function serialBytes(): Buffer {
  const b = randomBytes(16);
  b[0] = (b[0]! & 0x7f) | 0x40;
  return b;
}

function time(d: Date): A {
  // RFC 5280 §4.1.2.5: UTCTime through 2049, GeneralizedTime after.
  return d.getUTCFullYear() < 2050
    ? asn1.create(U, T.UTCTIME, false, asn1.dateToUtcTime(d))
    : asn1.create(U, T.GENERALIZEDTIME, false, asn1.dateToGeneralizedTime(d));
}

const nameCN = (cn: string) => seq([set([seq([oid(OID.commonName), utf8(cn)])])]);

const spkiOf = (pub: KeyObject) => asn1.fromDer(bin(pub.export({ type: "spki", format: "der" }) as Buffer), NO_BITS);

/** The signature algorithm and the signature, by the signing key's type. */
function signer(key: KeyObject): { alg: A; sign: (data: Buffer) => Buffer } {
  if (key.asymmetricKeyType === "ec")
    return { alg: seq([oid(OID.ecdsaSha256)]), sign: (d) => sign("sha256", d, { key, dsaEncoding: "der" }) };
  if (key.asymmetricKeyType === "rsa")
    return { alg: seq([oid(OID.rsaSha256), asn1.create(U, T.NULL, false, "")]), sign: (d) => sign("sha256", d, key) };
  throw new Error(`cannot sign a certificate with a ${key.asymmetricKeyType} key`);
}

const ext = (o: string, critical: boolean, value: A) =>
  seq([oid(o), ...(critical ? [bool(true)] : []), octets(der(value))]);
const sanDns = (hosts: string[]) => seq(hosts.map((h) => asn1.create(asn1.Class.CONTEXT_SPECIFIC, 2, false, h)));
const keyIdOf = (pub: KeyObject) =>
  // RFC 5280 §4.2.1.2 (1): SHA-1 of the subjectPublicKey BIT STRING — any stable id will do; SHA-256 truncated.
  createHash("sha256").update(pub.export({ type: "spki", format: "der" }) as Buffer).digest().subarray(0, 20);

export interface CertSpec {
  subjectCN: string;
  dnsNames: string[];
  /** The certified key (public). */
  subjectKey: KeyObject;
  /** Who signs: its private key and its name (DER of its subject); self-signed when absent. */
  issuer?: { key: KeyObject; nameDer: Buffer; keyId?: Buffer };
  /** Self-signed: the subject's private key. */
  selfKey?: KeyObject;
  notBefore: Date;
  notAfter: Date;
  ca?: boolean;
  /** Extra extensions (already encoded): [oid, critical, value]. */
  more?: [string, boolean, A][];
}

/** Build and sign a certificate (PEM). */
export function buildCert(c: CertSpec): string {
  const signKey = c.issuer?.key ?? c.selfKey;
  if (!signKey) throw new Error("no signing key");
  const s = signer(signKey);
  const subject = nameCN(c.subjectCN);
  const issuerName = c.issuer ? asn1.fromDer(bin(c.issuer.nameDer), NO_BITS) : subject;
  const exts: A[] = [
    ext(OID.basicConstraints, true, seq(c.ca ? [bool(true)] : [])),
    ext(OID.keyUsage, true, asn1.create(U, T.BITSTRING, false, c.ca ? "\x01\x06" : "\x07\x80")),
    ...(c.ca ? [] : [ext(OID.extKeyUsage, false, seq([oid(OID.serverAuth)]))]),
    ...(c.dnsNames.length ? [ext(OID.subjectAltName, false, sanDns(c.dnsNames))] : []),
    ext(OID.subjectKeyId, false, octets(keyIdOf(c.subjectKey))),
    ...(c.issuer?.keyId
      ? [ext(OID.authorityKeyId, false, seq([asn1.create(asn1.Class.CONTEXT_SPECIFIC, 0, false, bin(c.issuer.keyId))]))]
      : []),
    ...(c.more ?? []).map(([o, cr, v]) => ext(o, cr, v)),
  ];
  const tbs = seq([
    explicit(0, [int(Buffer.from([2]))]),
    int(serialBytes()),
    s.alg,
    issuerName,
    seq([time(c.notBefore), time(c.notAfter)]),
    subject,
    spkiOf(c.subjectKey),
    explicit(3, [seq(exts)]),
  ]);
  const tbsDer = der(tbs);
  const cert = seq([tbs, s.alg, bits(s.sign(tbsDer))]);
  return toPem("CERTIFICATE", der(cert));
}

export const toPem = (label: string, d: Buffer) =>
  `-----BEGIN ${label}-----\n${d.toString("base64").replace(/(.{64})/g, "$1\n").replace(/\n$/, "")}\n-----END ${label}-----\n`;

/** The self-signed certificate for `host` with `key` (the fallback, ADR-100). */
export function selfSignedCert(key: KeyObject, host: string, days: number, now = Date.now()): string {
  return buildCert({
    subjectCN: host,
    dnsNames: [host],
    subjectKey: createPublicKey(key),
    selfKey: key,
    notBefore: new Date(now - 60_000),
    notAfter: new Date(now + days * 86400_000),
  });
}

/**
 * RFC 8737 §3: the TLS-ALPN-01 certificate — self-signed, a fresh key, only
 * `host` in subjectAltName, and the critical acmeIdentifier extension whose
 * value is the OCTET STRING of SHA-256(key authorization).
 */
export function alpnChallengeCert(host: string, keyAuthorization: string, now = Date.now()): { cert: string; key: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const digest = createHash("sha256").update(keyAuthorization, "utf8").digest();
  const cert = buildCert({
    subjectCN: host,
    dnsNames: [host],
    subjectKey: publicKey,
    selfKey: privateKey,
    notBefore: new Date(now - 60_000),
    notAfter: new Date(now + 7 * 86400_000),
    more: [[OID.acmeIdentifier, true, octets(digest)]],
  });
  return { cert, key: privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
}

/** RFC 2986 / RFC 8555 §7.4: a CSR for `host` with `key`, DER. */
export function csrDer(key: KeyObject, host: string): Buffer {
  const s = signer(key);
  const info = seq([
    int(Buffer.from([0])),
    nameCN(host),
    spkiOf(createPublicKey(key)),
    explicit(0, [seq([oid(OID.extensionRequest), set([seq([ext(OID.subjectAltName, false, sanDns([host]))])])])]),
  ]);
  return der(seq([info, s.alg, bits(s.sign(der(info)))]));
}

/** What a CSR asks for, after its signature checks out (the tests' ACME server). */
export function readCsr(d: Buffer): { publicKey: KeyObject; dnsNames: string[] } {
  const top = asn1.fromDer(bin(d), NO_BITS) as any;
  const info = top.value[0];
  const sig = Buffer.from(top.value[2].value, "binary").subarray(1);
  if (top.value[2].type !== T.BITSTRING) throw new Error("malformed CSR");
  const spkiDer = der(info.value[2]);
  const publicKey = createPublicKey({ key: spkiDer, format: "der", type: "spki" });
  if (!verify("sha256", der(info), { key: publicKey, dsaEncoding: "der" }, sig)) throw new Error("bad CSR signature");
  const names: string[] = [];
  const attrs = info.value[3]?.value ?? [];
  for (const a of attrs)
    if (asn1.derToOid(a.value[0].value) === OID.extensionRequest)
      for (const e of a.value[1].value[0].value)
        if (asn1.derToOid(e.value[0].value) === OID.subjectAltName) {
          const san = asn1.fromDer(e.value[e.value.length - 1].value) as any;
          for (const g of san.value) if (g.type === 2) names.push(String(g.value));
        }
  return { publicKey, dnsNames: names };
}

/** The DER of a certificate's subject (to issue under it) and its key id. */
export function issuerOf(certPem: string): { nameDer: Buffer; keyId: Buffer } {
  const tbs = (asn1.fromDer(bin(new X509Certificate(certPem).raw), NO_BITS) as any).value[0];
  const subject = tbs.value[tbs.value[0].tagClass === asn1.Class.CONTEXT_SPECIFIC ? 5 : 4];
  const ski = extensionValue(tbs, OID.subjectKeyId);
  const keyId = ski ? Buffer.from((asn1.fromDer(ski) as any).value, "binary") : Buffer.alloc(0);
  return { nameDer: der(subject), keyId };
}

function extensionValue(tbs: any, want: string): string | null {
  for (const part of tbs.value)
    if (part.tagClass === asn1.Class.CONTEXT_SPECIFIC && part.type === 3)
      for (const e of part.value[0].value)
        if (asn1.derToOid(e.value[0].value) === want) return e.value[e.value.length - 1].value as string;
  return null;
}

/**
 * RFC 9773 §4.1: a certificate's ARI identifier — base64url of the
 * authority key identifier's keyIdentifier, ".", base64url of the serial
 * number's DER content octets. Null when the certificate has no AKI.
 */
export function ariCertId(certPem: string): string | null {
  const tbs = (asn1.fromDer(bin(new X509Certificate(certPem).raw), NO_BITS) as any).value[0];
  const serial = tbs.value[tbs.value[0].tagClass === asn1.Class.CONTEXT_SPECIFIC ? 1 : 0];
  const aki = extensionValue(tbs, OID.authorityKeyId);
  if (!aki) return null;
  const kid = ((asn1.fromDer(aki) as any).value as any[]).find((x) => x.tagClass === asn1.Class.CONTEXT_SPECIFIC && x.type === 0);
  if (!kid) return null;
  return `${Buffer.from(kid.value, "binary").toString("base64url")}.${Buffer.from(serial.value, "binary").toString("base64url")}`;
}

/** Does this certificate carry an acmeIdentifier extension with this digest (RFC 8737 §3)? */
export function alpnDigestOf(certPem: string): { critical: boolean; digest: Buffer } | null {
  const tbs = (asn1.fromDer(bin(new X509Certificate(certPem).raw), NO_BITS) as any).value[0];
  for (const part of tbs.value)
    if (part.tagClass === asn1.Class.CONTEXT_SPECIFIC && part.type === 3)
      for (const e of part.value[0].value)
        if (asn1.derToOid(e.value[0].value) === OID.acmeIdentifier) {
          const critical = e.value.length === 3 && e.value[1].value === "\xff";
          const inner = asn1.fromDer(e.value[e.value.length - 1].value) as any;
          return { critical, digest: Buffer.from(inner.value, "binary") };
        }
  return null;
}
