/** Isolated browser-test backend. Never used by the production start command. */
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { createApp } from "../packages/daisy/src/app.ts";
import { runNode } from "../packages/daisy/src/turns/worker.ts";
import { PIN_GRANT_HEADER } from "../packages/daisy/src/access/pin-seam.ts";
// P1-08 (scripts/e2e-web-origins.cjs): FIXTURE_EXTERNAL=<address> also
// opens the outside face there (FIXTURE_EXTERNAL_TLS=0: plain HTTP): the
// command line sets the PIN 246810 and uses it once for that.
// FIXTURE_PIN=1 (scripts/e2e-pin.cjs): the real PIN service, no PIN set,
// and the D-36 gate on — the page is what sets it.
const external = process.env.FIXTURE_EXTERNAL || "";
const dir = mkdtempSync(join(tmpdir(), "daisy-browser-"));
const { app, store, issueToken, access, runnerApi } = await createApp({
  // A fixture for UI work, not about the PIN (D-36 gate off) — except for
  // the PIN's own browser test.
  pinGate: !!process.env.FIXTURE_PIN,
  dataDir: dir,
  workspaceHome: join(dir, "workspaces/sandbox"),
  workspaceRoots: [join(dir, "workspaces/sandbox")],
  // e2e-context serves its own host harness instead of the app build.
  webDir: resolve(process.env.DAISY_E2E_WEB_DIR || "apps/app/dist"),
  sharedHost: () => false,
});
const url = await app.listen({ host: "127.0.0.1", port: 0 });
const config = JSON.parse(readFileSync(join(dir, "runner.json"), "utf8"));
// P1-02: the Runner calls the control plane in process.
config.api = runnerApi(config.nodeId);
config.identityRoot = join(dir, "identities");
for (const row of store.all("SELECT id,data FROM profiles")) {
  const profile = JSON.parse(row.data);
  profile.configDir = `managed:${row.id}`;
  store.run(
    "UPDATE profiles SET data=? WHERE id=?",
    JSON.stringify(profile),
    row.id,
  );
}
for (const a of ["CLAUDE", "CODEX", "KIMI"])
  process.env[`DAISY_${a}_BIN`] = resolve("tests/fixtures/agent.cjs");
writeFileSync(
  join(dir, "workspaces/sandbox/daisy-test.png"),
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6SVEAAAAASUVORK5CYII=",
    "base64",
  ),
);
mkdirSync(join(dir, "workspaces/sandbox/sample-project"));
const abort = new AbortController();
const runner = runNode(config, abort.signal);
// P1-03: no admin password any more. The driver gets a web session of
// the owner (`token`) and a one-time code for the page — the drivers open
// `${url}/#code=…`, what `daisy open` prints (scripts/e2e-open.cjs).
let outside: { externalUrl: string; externalCode: string } | {} = {};
if (external) {
  const cli = readFileSync(access.cliFile, "utf8").trim();
  const as = { authorization: `Bearer ${cli}` };
  await app.inject({ method: "POST", url: "/api/pin", headers: as, payload: { pin: "246810" } });
  const g = (
    await app.inject({ method: "POST", url: "/api/pin/grant", headers: as, payload: { pin: "246810" } })
  ).json().grant;
  const on = await app.inject({
    method: "PUT",
    url: "/api/access/external",
    headers: { ...as, [PIN_GRANT_HEADER]: g },
    payload: { host: external, tls: process.env.FIXTURE_EXTERNAL_TLS !== "0" },
  });
  if (on.statusCode !== 200) throw Error(`outside face: ${on.body}`);
  outside = {
    externalUrl: on.json().external.url,
    externalCode: access.web.issueCode("external").code,
  };
}
// P4-12 (scripts/e2e-sharing.cjs): FIXTURE_SHARING=1 — the PIN 246810 set,
// a public agent (a session on the fake CLI), and another Daisy "B" (its
// own key and card) whose AI calls that agent when the driver asks
// (`{ op: "call" }` over IPC → `{ op: "called", status, taskId }`).
let sharing: { peerCard: string; peerId: string; agentId: string } | {} = {};
let peerCall: (() => Promise<{ status: number; taskId: string | null }>) | null = null;
if (process.env.FIXTURE_SHARING) {
  const { SelfIssuer } = await import("../packages/daisy/src/access/tokens/self-issuer.ts");
  const { makeCard, cardText } = await import("../packages/daisy/src/contacts/card.ts");
  const cli = readFileSync(access.cliFile, "utf8").trim();
  const as = { authorization: `Bearer ${cli}` };
  await app.inject({ method: "POST", url: "/api/pin", headers: as, payload: { pin: "246810" } });
  const grant = async () =>
    (await app.inject({ method: "POST", url: "/api/pin/grant", headers: as, payload: { pin: "246810" } })).json().grant as string;
  const cat = (await app.inject({ url: "/api/catalog", headers: as })).json();
  const profile = cat.profiles.find((p: any) => p.agent === "claude");
  const s = (
    await app.inject({ method: "POST", url: "/api/sessions", headers: as, payload: { agent: "claude", title: "研究助手", workspaceId: cat.workspaces[0].id, profileId: profile.id } })
  ).json();
  // Public (P4-06, with the PIN) — once the Runner said what the fake CLI can do.
  for (let i = 0; ; i++) {
    const r = await app.inject({ method: "PUT", url: `/api/sessions/${s.id}/public`, headers: { ...as, [PIN_GRANT_HEADER]: await grant() }, payload: { public: true } });
    if (r.statusCode === 200) break;
    if (i > 100) throw Error(`public agent: ${r.body}`);
    await new Promise((ok) => setTimeout(ok, 100));
  }
  const peerDir = mkdtempSync(join(tmpdir(), "daisy-peer-"));
  const peer = await SelfIssuer.open(peerDir);
  const card = await makeCard(peer, { name: "B", addrs: [{ kind: "direct", url: "https://b.example.net:29600" }] });
  sharing = { peerCard: cardText(card), peerId: card.id, agentId: s.id };
  let n = 0;
  peerCall = async () => {
    const t = await peer.sign({ sub: peer.urn, aud: access.ai.urn, clientId: "a2a", scope: "daisy:invoke", ttlS: 120, act: { sub: "agent:b-research", name: "B 的研究助手" } });
    const r = await fetch(`${url}/a2a/${s.id}/message:send`, {
      method: "POST",
      headers: { authorization: `Bearer ${t.token}`, "content-type": "application/json", "a2a-version": "1.0" },
      body: JSON.stringify({ message: { messageId: `e2e-b-${Date.now()}-${++n}`, role: "ROLE_USER", parts: [{ text: "FX_SAY 你好，我是 B" }] }, configuration: { returnImmediately: true } }),
    });
    const j: any = await r.json().catch(() => null);
    return { status: r.status, taskId: (j?.task ?? j)?.id ?? null };
  };
  process.on("message", async (m: any) => {
    if (m?.op === "call" && peerCall) process.send?.({ op: "called", ...(await peerCall()) });
  });
}
process.send?.({
  url,
  token: issueToken(),
  code: access.web.issueCode("local").code,
  ...outside,
  ...sharing,
});
let closing = false;
for (const s of ["SIGINT", "SIGTERM"])
  process.on(s, async () => {
    if (closing) return;
    closing = true;
    abort.abort();
    await runner;
    await app.close();
    rmSync(dir, { recursive: true, force: true });
    process.exit(0);
  });
