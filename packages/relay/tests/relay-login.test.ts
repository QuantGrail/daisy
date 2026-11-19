/**
 * P5-01 (ADR-100 recommendation 3, ADR-143 §2): who may hold a subdomain.
 * Refused first (plan §10.2): every way to claim a subdomain without its
 * private key, or to take over someone's streams, is tried and must fail;
 * then the legitimate paths.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import tls from "node:tls";
import { WebSocket } from "ws";
import { fixture, until, sleep, DOMAIN, type Fixture } from "./helpers/fixture.ts";
import {
  call,
  dataUpgrade,
  handshake,
  localLookup,
  newIdentity,
  signProof,
  type Identity,
} from "./helpers/daisy-side.ts";
import { CLAIM_HEADER, CLOSE, PROOF_TYP, proofPayload, type ChallengeMsg } from "../src/protocol.ts";
import { subdomainOfKey } from "../src/proof.ts";
import { identityId } from "../../a2a-client/src/identity.ts";

interface Raw {
  ws: WebSocket;
  challenge: ChallengeMsg;
  messages: Record<string, unknown>[];
  closed: Promise<{ code: number; ms: number }>;
}

/** A bare control connection: resolves once the challenge arrived. */
function raw(f: Fixture, path = "/v1/control"): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`wss://${DOMAIN}:${f.relay.port}${path}`, {
      ca: f.ca.cert,
      lookup: localLookup,
    } as never);
    const t0 = Date.now();
    const messages: Record<string, unknown>[] = [];
    const closed = new Promise<{ code: number; ms: number }>((r) =>
      ws.on("close", (code) => r({ code, ms: Date.now() - t0 })),
    );
    ws.on("error", () => {});
    ws.on("unexpected-response", (_q, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    ws.on("message", (d) => {
      const m = JSON.parse(d.toString());
      messages.push(m);
      if (m.t === "challenge") resolve({ ws, challenge: m, messages, closed });
    });
    if (path !== "/v1/control") ws.on("open", () => resolve({ ws, challenge: null as never, messages, closed }));
  });
}

const hello = (proof: string) => JSON.stringify({ t: "hello", v: 1, proof });

async function refusedWith(
  f: Fixture,
  make: (c: ChallengeMsg) => Promise<string> | string,
  code: number = CLOSE.proofRefused,
) {
  const r = await raw(f);
  r.ws.send(await make(r.challenge));
  const c = await r.closed;
  assert.equal(c.code, code);
  assert.ok(!r.messages.some((m) => m.t === "welcome"), "no welcome");
  return r;
}

test("refused: a proof for someone else's key without their private key — signature, nonce replay, other relay, wrong typ, extra header, private key, version", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const victim = newIdentity();
  const attacker = newIdentity();

  // 1. The victim's public key in the payload, signed with the attacker's key.
  await refusedWith(f, (c) => signProof(attacker.privateKey, { ...proofPayload(c, victim.jwk) }).then(hello));
  // 2. A proof the victim really signed, replayed on a new connection (old nonce).
  const first = await raw(f);
  const victimProof = await signProof(victim.privateKey, { ...proofPayload(first.challenge, victim.jwk) });
  first.ws.close();
  await refusedWith(f, () => hello(victimProof));
  // 3. A proof the victim signed for another relay (another aud), with this connection's nonce.
  await refusedWith(f, (c) =>
    signProof(victim.privateKey, { ...proofPayload(c, victim.jwk), aud: "evil.test" }).then(hello),
  );
  // 4. The right signature but another type: an identity card, an access token.
  for (const typ of ["daisy-card+jwt", "at+jwt", undefined])
    await refusedWith(f, (c) =>
      signProof(
        victim.privateKey,
        { ...proofPayload(c, victim.jwk) },
        typ ? { alg: "EdDSA", typ } : { alg: "EdDSA" },
      ).then(hello),
    );
  // 5. Extra header members (a key carried in the header, a kid, crit).
  for (const extra of [{ jwk: victim.jwk }, { kid: victim.id }, { crit: ["b64"], b64: true }])
    await refusedWith(f, (c) =>
      signProof(victim.privateKey, { ...proofPayload(c, victim.jwk) }, { alg: "EdDSA", typ: PROOF_TYP, ...extra }).then(
        hello,
      ),
    );
  // 6. A key with a private part, a key of another curve, a malformed x.
  const d = (victim.privateKey.export({ format: "jwk" }) as { d: string }).d;
  await refusedWith(f, (c) =>
    signProof(victim.privateKey, { ...proofPayload(c, victim.jwk), key: { ...victim.jwk, d } }).then(hello),
  );
  await refusedWith(f, (c) =>
    signProof(victim.privateKey, { ...proofPayload(c, victim.jwk), key: { ...victim.jwk, crv: "Ed448" } }).then(hello),
  );
  await refusedWith(f, (c) =>
    signProof(victim.privateKey, {
      ...proofPayload(c, victim.jwk),
      key: { ...victim.jwk, x: victim.jwk.x + "A" },
    }).then(hello),
  );
  // 7. Another payload version; a nonce missing.
  await refusedWith(f, (c) => signProof(victim.privateKey, { ...proofPayload(c, victim.jwk), v: 2 }).then(hello));
  await refusedWith(f, (c) => {
    const { nonce: _n, ...p } = proofPayload(c, victim.jwk);
    return signProof(victim.privateKey, p).then(hello);
  });
  // 8. Not EdDSA at all: alg none, a MAC.
  await refusedWith(f, (c) => {
    const h = Buffer.from(JSON.stringify({ alg: "none", typ: PROOF_TYP })).toString("base64url");
    const p = Buffer.from(JSON.stringify(proofPayload(c, victim.jwk))).toString("base64url");
    return hello(`${h}.${p}.`);
  });
  await refusedWith(f, (c) => {
    const h = Buffer.from(JSON.stringify({ alg: "HS256", typ: PROOF_TYP })).toString("base64url");
    const p = Buffer.from(JSON.stringify(proofPayload(c, victim.jwk))).toString("base64url");
    return hello(`${h}.${p}.${Buffer.alloc(32).toString("base64url")}`);
  });
  // 9. A signature from another Ed25519 key over exactly the victim's payload.
  const other = generateKeyPairSync("ed25519").privateKey;
  await refusedWith(f, (c) => signProof(other, { ...proofPayload(c, victim.jwk) }).then(hello));

  // The victim's subdomain was never handed out.
  assert.deepEqual(f.relay.state().online, []);
  const h = await handshake(f.relay.port, `${victim.sub}.${DOMAIN}`, f.ca.cert);
  assert.match(h.message ?? "", /unrecognized name/);
  // Each refusal was logged with its reason, nothing secret.
  const reasons = f.logs
    .map((l) => JSON.parse(l))
    .filter((o) => o.ev === "control.refused")
    .map((o) => o.reason);
  for (const why of ["signature", "nonce", "aud", "header", "key", "version"]) assert.ok(reasons.includes(why), why);
  assert.equal(f.logger.dropped, 0);
});

test("refused: malformed logins — not a hello, binary, two hellos, no hello in time", async (t) => {
  const f = await fixture({ helloTimeoutMs: 400 });
  t.after(() => f.close());
  const id = newIdentity();
  await refusedWith(f, () => "not json", CLOSE.protocol);
  await refusedWith(f, () => JSON.stringify({ t: "claim", v: 1, claim: "x" }), CLOSE.protocol);
  await refusedWith(f, () => JSON.stringify({ t: "hello", v: 2, proof: "a.b.c" }), CLOSE.protocol);
  {
    const r = await raw(f);
    r.ws.send(Buffer.from([1, 2, 3]));
    assert.equal((await r.closed).code, CLOSE.protocol);
  }
  {
    // Two hellos at once: the second is a protocol error even though the first is valid.
    const r = await raw(f);
    const proof = await signProof(id.privateKey, { ...proofPayload(r.challenge, id.jwk) });
    r.ws.send(hello(proof));
    r.ws.send(hello(proof));
    assert.equal((await r.closed).code, CLOSE.protocol);
  }
  {
    const r = await raw(f);
    const c = await r.closed;
    assert.equal(c.code, CLOSE.timeout);
    assert.ok(c.ms < 2500, `closed after ${c.ms} ms`);
  }
  await until(() => f.relay.state().unauthenticatedControls === 0, 3000, "unauthenticated slots released");
  assert.deepEqual(f.relay.state().online, []);
});

test("refused: a second Daisy cannot take an online Daisy's subdomain or its streams", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const victim = f.daisy();
  await victim.start();
  // Another Daisy logs in, asking for the victim's subdomain: the relay never
  // takes a subdomain from the client — it gets its own, from its own key.
  const r = await raw(f);
  const intruder = newIdentity();
  r.ws.send(
    JSON.stringify({
      t: "hello",
      v: 1,
      subdomain: victim.identity.sub,
      host: victim.host,
      proof: await signProof(intruder.privateKey, {
        ...proofPayload(r.challenge, intruder.jwk),
        sub: victim.identity.sub,
      }),
    }),
  );
  await until(() => r.messages.some((m) => m.t === "welcome"), 3000, "welcome");
  const w = r.messages.find((m) => m.t === "welcome")!;
  assert.equal(w.subdomain, intruder.sub);
  assert.notEqual(w.subdomain, victim.identity.sub);
  assert.equal(w.id, intruder.id);
  // The victim is still online and still gets its own callers.
  assert.deepEqual(new Set(f.relay.state().online), new Set([victim.identity.sub, intruder.sub]));
  const res = await call(f.relay.port, victim.host, f.ca.cert);
  assert.equal(res.status, 200);
  assert.ok(res.body.startsWith(`daisy ${victim.identity.sub}`));
  assert.equal(r.messages.filter((m) => m.t === "open").length, 0, "the intruder saw none of the victim's opens");

  // A claim is good once, only for the stream it was made for — also while
  // that stream is still open (a second claimant would get the caller's bytes).
  const live = tls.connect({ host: "127.0.0.1", port: f.relay.port, servername: victim.host, ca: f.ca.cert });
  live.on("error", () => {});
  await new Promise((r) => live.once("secureConnect", r));
  const liveOpen = victim.opens.at(-1)!;
  const hijack = await dataUpgrade(f.relay.port, f.ca.cert, { [CLAIM_HEADER]: liveOpen.claim });
  assert.equal(hijack.status, 404, "a claim in use: refused before any upgrade");
  assert.equal(hijack.got.length, 0, "the second claimant got nothing");
  live.write("GET / HTTP/1.1\r\nhost: x\r\nconnection: close\r\n\r\n");
  const liveBody = await new Promise<string>((r) => {
    let b = "";
    live.on("data", (c) => (b += c));
    live.on("close", () => r(b));
  });
  assert.match(liveBody, /200 OK[\s\S]*daisy /, "the live stream still works");
  const opened = victim.opens.at(-1)!;
  assert.equal(
    (await dataUpgrade(f.relay.port, f.ca.cert, { [CLAIM_HEADER]: opened.claim })).status,
    404,
    "a used claim",
  );
  const guessed = Buffer.alloc(32, 7).toString("base64url");
  assert.equal(
    (await dataUpgrade(f.relay.port, f.ca.cert, { [CLAIM_HEADER]: guessed })).status,
    404,
    "a guessed claim",
  );
  assert.equal((await dataUpgrade(f.relay.port, f.ca.cert, {})).status, 404, "no claim");
  assert.equal(
    (await dataUpgrade(f.relay.port, f.ca.cert, { [CLAIM_HEADER]: "short" })).status,
    404,
    "a malformed claim",
  );
  // The intruder rejecting the victim's open (it never got the claim; try a guessed one): nothing happens.
  r.ws.send(JSON.stringify({ t: "reject", v: 1, claim: opened.claim }));
  assert.equal((await call(f.relay.port, victim.host, f.ca.cert)).status, 200);
});

test("the same key logging in again replaces the old connection (only the key holder can)", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const id: Identity = newIdentity();
  const a = f.daisy({ identity: id, backoff: { baseMs: 60_000, maxMs: 60_000 } });
  await a.start();
  const closedA = new Promise<number>((r) => a.once("closed", r));
  const b = f.daisy({ identity: id });
  await b.start();
  assert.equal(await closedA, CLOSE.replaced);
  assert.deepEqual(f.relay.state().online, [id.sub]);
  const res = await call(f.relay.port, b.host, f.ca.cert);
  assert.equal(res.status, 200);
  assert.equal(b.opens.length, 1);
  assert.equal(a.opens.length, 0);
  assert.ok(f.logs.some((l) => JSON.parse(l).ev === "daisy.replaced"));
});

test("the subdomain is the first 160 bits of the identity thumbprint, base32 — the identity number's first 32 characters", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const d = f.daisy();
  const w = await d.start();
  const id = identityId(d.identity.jwk);
  assert.equal(w.subdomain, id.slice(0, 32));
  assert.equal(w.subdomain, subdomainOfKey(d.identity.jwk));
  assert.match(w.subdomain, /^[a-z2-7]{32}$/);
  assert.equal(w.host, `${w.subdomain}.${DOMAIN}`);
  assert.equal(w.id, id);
  // Stable across reconnects.
  d.dropControl();
  const w2 = await d.nextWelcome();
  assert.equal(w2.subdomain, w.subdomain);
});

test("refused: the Daisy declines an open → the caller is refused at once", async (t) => {
  const f = await fixture({ claimTimeoutMs: 4000 });
  t.after(() => f.close());
  const d = f.daisy({ silent: true });
  await d.start();
  d.on("open", (m) => d.reject(m.claim));
  const t0 = Date.now();
  const h = await handshake(f.relay.port, d.host, f.ca.cert);
  assert.match(h.message ?? "", /internal error/);
  assert.ok(Date.now() - t0 < 1500);
  assert.equal(f.relay.state().pending, 0);
});

test("refused: more Daisys than maxDaisys; too many logins in progress", async (t) => {
  const f = await fixture({ maxDaisys: 2, maxUnauthenticatedControls: 2 });
  t.after(() => f.close());
  const a = f.daisy();
  const b = f.daisy();
  await a.start();
  await b.start();
  const r = await raw(f);
  const c = newIdentity();
  r.ws.send(hello(await signProof(c.privateKey, { ...proofPayload(r.challenge, c.jwk) })));
  assert.equal((await r.closed).code, CLOSE.full);
  // A Daisy already online reconnecting is not a new one.
  a.dropControl();
  await a.nextWelcome();
  assert.equal(f.relay.state().online.length, 2);

  // Logins in progress: two hold the slots, the third is turned away at the upgrade.
  const p1 = await raw(f);
  const p2 = await raw(f);
  await assert.rejects(raw(f), /HTTP 503/);
  p1.ws.close();
  p2.ws.close();
  await until(() => f.relay.state().unauthenticatedControls === 0, 3000, "slots released");
  await sleep(50);
});
