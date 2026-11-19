/**
 * Test PKI for the relay tests: a throwaway certificate authority and
 * leaf certificates for the fake domain `relay.test` (D-41 ③: no real
 * domain, no real ACME). RSA, because node-forge signs only RSA.
 */
import { generateKeyPairSync, createHash, X509Certificate } from "node:crypto";
import forge from "node-forge";

export interface Leaf {
  cert: string;
  key: string;
  /** SHA-256 of the certificate's SubjectPublicKeyInfo, base64 (what a TLS binding statement pins). */
  spki: string;
}

function rsa() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    keyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    pubPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

export const spkiOf = (certPem: string) =>
  createHash("sha256")
    .update(new X509Certificate(certPem).publicKey.export({ type: "spki", format: "der" }))
    .digest("base64");

export class TestCA {
  readonly cert: string;
  private readonly key: forge.pki.rsa.PrivateKey;
  private readonly subject: forge.pki.CertificateField[];
  constructor(name = "Relay Test CA") {
    const k = rsa();
    this.key = forge.pki.privateKeyFromPem(k.keyPem);
    const c = forge.pki.createCertificate();
    c.publicKey = forge.pki.publicKeyFromPem(k.pubPem);
    c.serialNumber = "01" + forge.util.bytesToHex(forge.random.getBytesSync(8));
    c.validity.notBefore = new Date(Date.now() - 60_000);
    c.validity.notAfter = new Date(Date.now() + 86_400_000);
    this.subject = [{ name: "commonName", value: name }];
    c.setSubject(this.subject);
    c.setIssuer(this.subject);
    c.setExtensions([
      { name: "basicConstraints", cA: true, critical: true },
      { name: "keyUsage", keyCertSign: true, cRLSign: true, critical: true },
    ]);
    c.sign(this.key, forge.md.sha256.create());
    this.cert = forge.pki.certificateToPem(c);
  }
  issue(dnsNames: string[]): Leaf {
    const k = rsa();
    const c = forge.pki.createCertificate();
    c.publicKey = forge.pki.publicKeyFromPem(k.pubPem);
    c.serialNumber = "02" + forge.util.bytesToHex(forge.random.getBytesSync(8));
    c.validity.notBefore = new Date(Date.now() - 60_000);
    c.validity.notAfter = new Date(Date.now() + 86_400_000);
    c.setSubject([{ name: "commonName", value: dnsNames[0]! }]);
    c.setIssuer(this.subject);
    c.setExtensions([
      { name: "basicConstraints", cA: false },
      { name: "keyUsage", digitalSignature: true, keyEncipherment: true, critical: true },
      { name: "extKeyUsage", serverAuth: true },
      { name: "subjectAltName", altNames: dnsNames.map((value) => ({ type: 2, value })) },
    ]);
    c.sign(this.key, forge.md.sha256.create());
    const cert = forge.pki.certificateToPem(c);
    return { cert, key: k.keyPem, spki: spkiOf(cert) };
  }
}
