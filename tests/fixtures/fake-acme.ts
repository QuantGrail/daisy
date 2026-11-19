/**
 * P5-02 tests: an ACME server stand-in (RFC 8555 + RFC 8737 TLS-ALPN-01 +
 * RFC 9773 ARI), in process, HTTPS on the fake name `acme.test` — written
 * from the RFCs, independent of the client: every request's JWS is checked
 * with jose (alg ES256, `url`, a nonce it issued, `jwk` only on newAccount,
 * `kid` after), and a challenge is validated the way a CA does it — a TLS
 * handshake to the name through the relay's public port with ALPN
 * `acme-tls/1`, the certificate holding only that name and the critical
 * acmeIdentifier extension with SHA-256 of the key authorization.
 * Certificates come from its own ECDSA test root.
 */
import https from "node:https";
import tls from "node:tls";
import { createHash, generateKeyPairSync, X509Certificate } from "node:crypto";
import { calculateJwkThumbprint, decodeProtectedHeader, flattenedVerify, importJWK, type JWK } from "jose";
import { TestCA } from "../../packages/relay/tests/helpers/pki.ts";
import { alpnDigestOf, ariCertId, buildCert, issuerOf, readCsr } from "../../packages/daisy/src/relay/x509.ts";

export interface FakeAcmeOptions {
  /** Where the relay's public port is (challenges are checked through it). */
  relayPort: number;
}

export async function fakeAcme(o: FakeAcmeOptions) {
  const tlsCa = new TestCA("ACME Server TLS CA");
  const own = tlsCa.issue(["acme.test"]);
  const root = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const rootPem = buildCert({
    subjectCN: "Fake ACME Root",
    dnsNames: [],
    subjectKey: root.publicKey,
    selfKey: root.privateKey,
    notBefore: new Date(Date.now() - 60_000),
    notAfter: new Date(Date.now() + 365 * 86400_000),
    ca: true,
  });
  const iss = issuerOf(rootPem);
  const st = {
    failChallenge: false,
    /** The ARI window to suggest (null: no renewalInfo in the directory). */
    ari: { start: Date.now() + 60 * 86400_000, end: Date.now() + 61 * 86400_000 } as { start: number; end: number } | null,
    nonces: new Set<string>(),
    accounts: new Map<string, JWK>(),
    orders: [] as any[],
    validations: [] as { host: string; alpn: string | null; ok: boolean; why?: string }[],
    issued: [] as { pem: string; replaces: string | null }[],
    requests: [] as { path: string; kid: string | null }[],
    badNonceOnce: true,
  };
  let base = "";
  let n = 0;
  const nonce = () => {
    const v = `n${++n}${Math.random().toString(36).slice(2)}`;
    st.nonces.add(v);
    return v;
  };

  async function validate(order: any) {
    const host = order.host;
    const keyAuth = `${order.token}.${await calculateJwkThumbprint(st.accounts.get(order.kid)!, "sha256")}`;
    const want = createHash("sha256").update(keyAuth).digest();
    const r = await new Promise<{ ok: boolean; alpn: string | null; why?: string }>((resolve) => {
      const s = tls.connect({ host: "127.0.0.1", port: o.relayPort, servername: host, ALPNProtocols: ["acme-tls/1"], rejectUnauthorized: false });
      s.on("secureConnect", () => {
        const alpn = s.alpnProtocol || null;
        const x = s.getPeerX509Certificate();
        s.destroy();
        if (alpn !== "acme-tls/1" || !x) return resolve({ ok: false, alpn, why: "alpn" });
        const pem = x.toString();
        const san = x.subjectAltName;
        const ext = alpnDigestOf(pem);
        if (san !== `DNS:${host}`) return resolve({ ok: false, alpn, why: "san" });
        if (!ext || !ext.critical || !ext.digest.equals(want)) return resolve({ ok: false, alpn, why: "acmeIdentifier" });
        resolve({ ok: true, alpn });
      });
      s.on("error", (e) => resolve({ ok: false, alpn: null, why: e.message }));
    });
    const ok = r.ok && !st.failChallenge;
    st.validations.push({ host, alpn: r.alpn, ok, ...(r.why ? { why: r.why } : {}) });
    order.authz = ok ? "valid" : "invalid";
    order.status = ok ? "ready" : "invalid";
  }

  const server = https.createServer({ cert: own.cert, key: own.key }, async (req, res) => {
    const url = new URL(req.url ?? "/", base);
    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "replay-nonce": nonce(), "content-type": typeof body === "string" ? "application/pem-certificate-chain" : "application/json", ...headers });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    };
    const problem = (status: number, type: string, detail: string) => {
      res.writeHead(status, { "replay-nonce": nonce(), "content-type": "application/problem+json" });
      res.end(JSON.stringify({ type: `urn:ietf:params:acme:error:${type}`, detail }));
    };
    if (url.pathname === "/directory")
      return send(200, {
        newNonce: `${base}/new-nonce`,
        newAccount: `${base}/new-account`,
        newOrder: `${base}/new-order`,
        ...(st.ari ? { renewalInfo: `${base}/renewal-info` } : {}),
      });
    if (url.pathname === "/new-nonce") return send(200, {});
    if (url.pathname.startsWith("/renewal-info/") && req.method === "GET") {
      if (!st.ari) return problem(404, "malformed", "no ARI");
      return send(200, { suggestedWindow: { start: new Date(st.ari.start).toISOString(), end: new Date(st.ari.end).toISOString() } }, { "retry-after": "21600" });
    }
    if (req.method !== "POST") return problem(405, "malformed", "POST only");
    let raw = "";
    for await (const c of req) raw += c;
    // RFC 8555 §6.2: a flattened JWS, ES256, url, a nonce we issued; jwk xor kid.
    let jws: any, hdr: any;
    try {
      jws = JSON.parse(raw);
      hdr = decodeProtectedHeader(jws);
    } catch {
      return problem(400, "malformed", "not a JWS");
    }
    if (hdr.alg !== "ES256") return problem(400, "badSignatureAlgorithm", "ES256 only");
    if (hdr.url !== `${base}${url.pathname}`) return problem(400, "unauthorized", "url mismatch");
    if (st.badNonceOnce) {
      st.badNonceOnce = false;
      st.nonces.delete(hdr.nonce);
      return problem(400, "badNonce", "try again");
    }
    if (!st.nonces.delete(hdr.nonce)) return problem(400, "badNonce", "unknown nonce");
    if (!!hdr.jwk === !!hdr.kid) return problem(400, "malformed", "jwk xor kid");
    if (hdr.jwk && url.pathname !== "/new-account") return problem(400, "malformed", "jwk only on newAccount");
    const jwk: JWK | undefined = hdr.jwk ?? st.accounts.get(hdr.kid);
    if (!jwk) return problem(400, "accountDoesNotExist", "no such account");
    let payload: any;
    try {
      const v = await flattenedVerify(jws, await importJWK(jwk, "ES256"));
      const text = new TextDecoder().decode(v.payload);
      payload = text === "" ? null : JSON.parse(text);
    } catch {
      return problem(400, "unauthorized", "bad signature");
    }
    st.requests.push({ path: url.pathname, kid: hdr.kid ?? null });
    const [, kind, id] = url.pathname.split("/");
    if (kind === "new-account") {
      if (payload?.termsOfServiceAgreed !== true) return problem(400, "userActionRequired", "agree to the terms");
      const kid = `${base}/acct/${st.accounts.size + 1}`;
      st.accounts.set(kid, hdr.jwk);
      return send(201, { status: "valid" }, { location: kid });
    }
    if (kind === "new-order") {
      const host = payload?.identifiers?.[0]?.value;
      const oid = String(st.orders.length);
      const order = { id: oid, kid: hdr.kid, host, token: `tok${oid}${"x".repeat(30)}`, status: "pending", authz: "pending", replaces: payload?.replaces ?? null, cert: null as string | null };
      st.orders.push(order);
      return send(201, view(order), { location: `${base}/order/${oid}` });
    }
    const order = st.orders[Number(id)];
    if (!order || order.kid !== hdr.kid) return problem(404, "malformed", "no such resource");
    if (kind === "authz")
      return send(200, {
        status: order.authz,
        identifier: { type: "dns", value: order.host },
        challenges: [
          { type: "http-01", url: `${base}/http/${order.id}`, token: "h".repeat(40), status: "pending" },
          { type: "tls-alpn-01", url: `${base}/chall/${order.id}`, token: order.token, status: order.authz },
        ],
      });
    if (kind === "chall") {
      void validate(order);
      return send(200, { type: "tls-alpn-01", status: "processing", token: order.token });
    }
    if (kind === "order") return send(200, view(order));
    if (kind === "finalize") {
      if (order.status !== "ready") return problem(403, "orderNotReady", "not ready");
      const csr = readCsr(Buffer.from(payload.csr, "base64url"));
      if (csr.dnsNames.length !== 1 || csr.dnsNames[0] !== order.host) return problem(400, "badCSR", "names");
      const pem = buildCert({
        subjectCN: order.host,
        dnsNames: [order.host],
        subjectKey: csr.publicKey,
        issuer: { key: root.privateKey, nameDer: iss.nameDer, keyId: iss.keyId },
        notBefore: new Date(Date.now() - 60_000),
        notAfter: new Date(Date.now() + 90 * 86400_000),
      });
      order.cert = pem + rootPem;
      order.status = "valid";
      st.issued.push({ pem, replaces: order.replaces });
      return send(200, view(order));
    }
    if (kind === "cert") return send(200, order.cert);
    return problem(404, "malformed", "unknown");
  });
  const view = (order: any) => ({
    status: order.status,
    identifiers: [{ type: "dns", value: order.host }],
    authorizations: [`${base}/authz/${order.id}`],
    finalize: `${base}/finalize/${order.id}`,
    ...(order.cert ? { certificate: `${base}/cert/${order.id}` } : {}),
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as any).port;
  base = `https://acme.test:${port}`;
  return {
    st,
    directory: `${base}/directory`,
    /** The test CA behind the ACME server's own HTTPS (the client's transport `ca`). */
    tlsCa: tlsCa.cert,
    /** The root the issued certificates chain to (a caller's `ca`). */
    root: rootPem,
    certIdOf: (pem: string) => ariCertId(pem),
    leafOf: (chain: string) => new X509Certificate(chain),
    close: () => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r()))),
  };
}
export type FakeAcme = Awaited<ReturnType<typeof fakeAcme>>;
