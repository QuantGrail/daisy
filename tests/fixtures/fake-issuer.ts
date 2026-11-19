/**
 * P2-01 / P2-02 tests: a fake external issuer on this machine's loopback —
 * no real platform. It serves RFC 8414 metadata, a JWKS with one
 * Ed25519 and one RSA-2048 key (Cache-Control settable, can go down, can
 * rotate), and an RFC 8693 token endpoint that checks the client
 * assertion (RFC 7523, the Daisy's registered public key), the subject
 * token (its own) and the actor token (the Daisy's), then signs an access
 * token with `act`. `misbehave` makes it hand back a token that breaks one
 * of token.md §6's rules, to see Daisy refuse it.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  importJWK,
  jwtVerify,
  type JWK,
  type JWTPayload,
} from "jose";

// Review M-3: Daisy talks plain http to a loopback issuer only with this
// switch (and on a machine nobody else has an account on: the test apps
// say sharedHost() is false).
process.env.DAISY_ALLOW_HTTP_ISSUER = "1";

type Alg = "EdDSA" | "RS256";
interface Key {
  kid: string;
  alg: Alg;
  privateKey: CryptoKey;
  jwk: JWK;
}
async function makeKey(kid: string, alg: Alg): Promise<Key> {
  const { privateKey, publicKey } = await generateKeyPair(alg, {
    extractable: true,
    ...(alg === "EdDSA" ? { crv: "Ed25519" } : { modulusLength: 2048 }),
  });
  const jwk = { ...(await exportJWK(publicKey)), kid, alg, use: "sig" };
  return { kid, alg, privateKey: privateKey as CryptoKey, jwk };
}

export interface Misbehave {
  sub?: string;
  dropAct?: boolean;
  actSub?: string;
  ttlS?: number;
  extraScope?: string;
  audience?: string;
  /** Sign with a key not in the JWKS. */
  foreignKey?: boolean;
  tokenType?: string;
  issuedTokenType?: string;
}

export async function fakeIssuer(o: { cacheControl?: string; path?: string } = {}) {
  const keys: Key[] = [await makeKey("ed-1", "EdDSA"), await makeKey("rs-1", "RS256")];
  const foreign = await makeKey("ed-1", "EdDSA"); // same kid, another key
  const state = {
    cacheControl: o.cacheControl ?? "max-age=3600",
    down: false,
    jwksFetches: 0,
    exchanges: [] as { form: Record<string, string>; ok: boolean; error?: string }[],
    misbehave: null as Misbehave | null,
    /** client_id → its public JWK (what the owner registered at the issuer). */
    clients: new Map<string, JWK>(),
  };
  let issuer = "";
  const jwks = () => ({ keys: keys.map((k) => k.jwk) });

  async function sign(
    claims: JWTPayload & Record<string, unknown>,
    /** `iat: null`: a token without `iat` (its `exp` is then counted from now). */
    opt: { alg?: Alg; kid?: string; typ?: string; key?: CryptoKey; ttlS?: number; iat?: number | null } = {},
  ): Promise<string> {
    const k = keys.find((x) => x.alg === (opt.alg ?? "EdDSA"))!;
    const iat = opt.iat ?? Math.floor(Date.now() / 1000);
    const jwt = new SignJWT({
      client_id: "fake-ui",
      scope: "daisy:session:read daisy:session:write daisy:manage daisy:grant",
      jti: randomBytes(12).toString("base64url"),
      ...claims,
    })
      .setProtectedHeader({ alg: k.alg, typ: opt.typ ?? "at+jwt", kid: opt.kid ?? k.kid })
      .setIssuer(typeof claims.iss === "string" ? claims.iss : issuer)
      .setExpirationTime(typeof claims.exp === "number" ? claims.exp : iat + (opt.ttlS ?? 600));
    if (opt.iat !== null) jwt.setIssuedAt(iat);
    return jwt.sign(opt.key ?? k.privateKey);
  }

  const send = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  };
  const readBody = (req: IncomingMessage) =>
    new Promise<string>((ok) => {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => ok(b));
    });

  async function token(req: IncomingMessage, res: ServerResponse) {
    const form = Object.fromEntries(new URLSearchParams(await readBody(req)));
    const fail = (error: string, status = 400) => {
      state.exchanges.push({ form, ok: false, error });
      send(res, status, { error });
    };
    if (form.grant_type !== "urn:ietf:params:oauth:grant-type:token-exchange") return fail("unsupported_grant_type");
    // RFC 7523: the client proves itself with its registered key.
    const client = state.clients.get(form.client_id ?? "");
    if (!client || form.client_assertion_type !== "urn:ietf:params:oauth:client-assertion-type:jwt-bearer")
      return fail("invalid_client", 401);
    try {
      const ck = await importJWK(client, "EdDSA");
      const { payload } = await jwtVerify(form.client_assertion!, ck, { audience: issuer, algorithms: ["EdDSA"] });
      if (payload.iss !== form.client_id || payload.sub !== form.client_id) return fail("invalid_client", 401);
      // The subject: a token this issuer signed.
      const subj = await jwtVerify(form.subject_token!, createLocalJWKSet(jwks()), { issuer, typ: "at+jwt" });
      if (form.subject_token_type !== "urn:ietf:params:oauth:token-type:access_token") return fail("invalid_request");
      // The actor: signed by the same client (the Daisy names its AI).
      const actor = await jwtVerify(form.actor_token!, ck, { audience: issuer, algorithms: ["EdDSA"] });
      if (form.actor_token_type !== "urn:ietf:params:oauth:token-type:jwt") return fail("invalid_request");
      const have = String(subj.payload.scope ?? "").split(" ");
      const want = String(form.scope ?? "").split(" ").filter(Boolean);
      if (!want.length || want.some((s) => !have.includes(s))) return fail("invalid_scope");
      const m = state.misbehave ?? {};
      const ttl = m.ttlS ?? 3600;
      const k = keys[0]!;
      const access = await new SignJWT({
        client_id: form.client_id,
        scope: [...want, ...(m.extraScope ? [m.extraScope] : [])].join(" "),
        jti: randomBytes(12).toString("base64url"),
        ...(m.dropAct ? {} : { act: { sub: m.actSub ?? actor.payload.sub } }),
      })
        .setProtectedHeader({ alg: "EdDSA", typ: "at+jwt", kid: k.kid })
        .setIssuer(issuer)
        .setSubject(m.sub ?? String(subj.payload.sub))
        .setAudience(m.audience ?? form.audience!)
        .setIssuedAt()
        .setExpirationTime(Math.floor(Date.now() / 1000) + ttl)
        .sign(m.foreignKey ? foreign.privateKey : k.privateKey);
      state.exchanges.push({ form, ok: true });
      send(res, 200, {
        access_token: access,
        issued_token_type: m.issuedTokenType ?? "urn:ietf:params:oauth:token-type:access_token",
        token_type: m.tokenType ?? "Bearer",
        expires_in: ttl,
        scope: want.join(" "),
      });
    } catch {
      return fail("invalid_grant");
    }
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const prefix = o.path ?? "";
    if (state.down) return req.socket.destroy();
    if (req.method === "GET" && url.pathname === `/.well-known/oauth-authorization-server${prefix}`)
      return send(res, 200, { issuer, jwks_uri: `${issuer}/jwks`, token_endpoint: `${issuer}/token` });
    if (req.method === "GET" && url.pathname === `${prefix}/jwks`) {
      state.jwksFetches++;
      return send(res, 200, jwks(), state.cacheControl ? { "cache-control": state.cacheControl } : {});
    }
    if (req.method === "POST" && url.pathname === `${prefix}/token`) return void token(req, res);
    send(res, 404, { error: "not_found" });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const port = (server.address() as any).port as number;
  issuer = `http://127.0.0.1:${port}${o.path ?? ""}`;

  return {
    get issuer() {
      return issuer;
    },
    port,
    state,
    keys,
    sign,
    /** A token signed by a key with a JWKS kid but not in the JWKS. */
    signForeign: (claims: JWTPayload & Record<string, unknown>) => sign(claims, { key: foreign.privateKey }),
    /** Rotate: the Ed25519 key is replaced by a new one under a new kid. */
    async rotate(kid = "ed-2") {
      keys[0] = await makeKey(kid, "EdDSA");
    },
    close: () =>
      new Promise<void>((ok) => {
        server.close(() => ok());
        server.closeAllConnections();
      }),
  };
}
export type FakeIssuer = Awaited<ReturnType<typeof fakeIssuer>>;
