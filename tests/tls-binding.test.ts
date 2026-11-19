/**
 * P5-02 (ADR-100 「TLS 绑定声明」, a2a-usage.md §15.1): reading a TLS
 * binding claim — refusals first (every way a claim can be wrong), then
 * the verifier's cache, and the client's rule that a relay address is
 * never called without one (fail closed).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { CompactSign } from "jose";
import { identityId, type PublicJwk } from "../packages/a2a-client/src/identity.ts";
import { BindingError, TlsBindingVerifier, TLS_BINDING_TYP, verifyBindingClaim } from "../packages/a2a-client/src/binding.ts";
import { A2APeer, PeerError } from "../packages/a2a-client/src/peer.ts";
import { SelfIssuer } from "../packages/daisy/src/access/tokens/self-issuer.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function key(): { priv: KeyObject; jwk: PublicJwk } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const x = (publicKey.export({ format: "jwk" }) as any).x;
  return { priv: privateKey, jwk: { kty: "OKP", crv: "Ed25519", x } };
}
const S1 = "A".repeat(43);
const S2 = "B".repeat(43);
const now = () => Math.floor(Date.now() / 1000);
const sign = (priv: KeyObject, payload: unknown, header: Record<string, unknown> = { alg: "EdDSA", typ: TLS_BINDING_TYP }) =>
  new CompactSign(new TextEncoder().encode(typeof payload === "string" ? payload : JSON.stringify(payload))).setProtectedHeader(header as any).sign(priv);

test("refused: another key's signature, a wrong or extra header member, another typ, a bad payload, another identity, times, the key list", async () => {
  const k = key();
  const other = key();
  const id = identityId(k.jwk);
  const good = { v: 1, id, spki: [S1], iat: now(), exp: now() + 3600 };
  const code = async (jws: string, want: BindingError["code"]) => {
    await assert.rejects(verifyBindingClaim(jws, k.jwk), (e: any) => e instanceof BindingError && e.code === want, want);
  };
  await code(await sign(other.priv, good), "signature");
  await code(await sign(k.priv, good, { alg: "EdDSA", typ: "daisy-card+jwt" }), "malformed");
  await code(await sign(k.priv, good, { alg: "EdDSA", typ: "at+jwt" }), "malformed");
  await code(await sign(k.priv, good, { alg: "EdDSA", typ: "daisy-relay-proof+jwt" }), "malformed");
  await code(await sign(k.priv, good, { alg: "EdDSA", typ: TLS_BINDING_TYP, kid: id }), "malformed");
  await code(await sign(k.priv, good, { alg: "EdDSA", typ: TLS_BINDING_TYP, jwk: other.jwk }), "malformed");
  await code(await sign(k.priv, good, { alg: "EdDSA" }), "malformed");
  await code("not.a.jws!", "malformed");
  await code("a".repeat(5000), "malformed");
  await code(await sign(k.priv, "not json"), "claims");
  await code(await sign(k.priv, { ...good, v: 2 }), "claims");
  await code(await sign(k.priv, { ...good, id: identityId(other.jwk) }), "claims");
  await code(await sign(k.priv, { ...good, spki: [] }), "claims");
  await code(await sign(k.priv, { ...good, spki: ["short"] }), "claims");
  await code(await sign(k.priv, { ...good, spki: Array(9).fill(S1) }), "claims");
  await code(await sign(k.priv, { ...good, exp: now() - 1 }), "claims");
  await code(await sign(k.priv, { ...good, iat: now() + 3600 }), "claims");
  await code(await sign(k.priv, { ...good, exp: good.iat + 8 * 86400 }), "claims");
  await code(await sign(k.priv, { ...good, iat: "x" }), "claims");
  // The one that passes.
  const c = await verifyBindingClaim(await sign(k.priv, good), k.jwk);
  assert.deepEqual(c.spki, [S1]);
});

test("Daisy's own claim (SelfIssuer.signTlsBinding) verifies with its card key; the verifier fetches once per origin, then refuses a key the claim does not name", async () => {
  const dir = mkdtempSync(join(tmpdir(), "daisy-binding-"));
  try {
    const self = await SelfIssuer.open(dir);
    const text = await self.signTlsBinding({ v: 1, id: self.kid, spki: [S1], iat: now(), exp: now() + 3600 });
    let fetched = 0;
    const v = new TlsBindingVerifier({
      key: self.publicJwk as PublicJwk,
      fetch: async () => {
        fetched++;
        return text;
      },
    });
    await v.check("https://x.relay.test", S1);
    await v.check("https://x.relay.test", S1);
    assert.equal(fetched, 1);
    await assert.rejects(v.check("https://x.relay.test", S2), (e: any) => e.code === "mismatch");
    assert.equal(fetched, 2, "an unknown key asks again (the claim may have changed)");
    // A relay proof or a card from the same key is not a claim.
    const proof = await self.signRelayProof({ v: 1, aud: "relay.test", nonce: "n", key: self.publicJwk as any });
    await assert.rejects(verifyBindingClaim(proof, self.publicJwk as any), (e: any) => e.code === "malformed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fail closed: a relay address is never called without a binding verifier — nothing is signed, nothing is sent", async () => {
  let signed = 0;
  const peer = new A2APeer({
    root: "https://abc.relay.test",
    kind: "relay",
    token: async () => {
      signed++;
      return "t";
    },
  });
  await assert.rejects(peer.directory(), (e: any) => e instanceof PeerError && e.kind === "refused" && /TLS 绑定声明/.test(e.message));
  assert.equal(signed, 0);
});
