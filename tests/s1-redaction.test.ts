/**
 * P1-11 / S-1 (3.7 安全基线): no credential, token, PIN, passcode, grant or
 * API key in a log line, an error answer or the audit.
 *
 * The scenario runs what makes the most noise with secrets in hand — a
 * harness's fake login (its pasted code), an identity with an API key, the
 * web page's one-time codes and sessions, a PIN grant, the AI's working
 * credential, refusals of every kind, an internal error and a Runner call
 * that fail with a secret in their message, careless log lines — and
 * collects everything written: standard output and error (as written,
 * through the patched console too), Daisy's log lines, the audit tables,
 * every error answer, the owner's log and audit views, and any *.log file
 * in the data directory. None of the secrets may be in any of it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createApp } from "../packages/daisy/src/app.ts";
import { api } from "../packages/contracts/src/api/index.ts";
import {
  installConsoleRedaction,
  log,
  onLog,
} from "../packages/daisy/src/observe/log.ts";
import { MASK, redact, registerSecret } from "../packages/daisy/src/observe/redact.ts";
import { fakeIssuer } from "./fixtures/fake-issuer.ts";
import { PIN_GRANT_HEADER } from "../packages/daisy/src/access/pin-seam.ts";
import { serve } from "../packages/daisy/src/app/serve.ts";
import { RunnerPort } from "../packages/daisy/src/app/runner-port.ts";
import { runnerHeaders, runnerInject } from "./fixtures/runner-calls.ts";

const PIN = "246810";

test("redact: shapes of secrets are masked; ordinary text is left alone", () => {
  const cases: [string, string][] = [
    ["Authorization: Bearer abcdefghijklmnop", "abcdefghijklmnop"],
    ["token eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJ4eXoifQ.c2lnbmF0dXJl here", "eyJhbGciOiJFZERTQSJ9"],
    ["key sk-ant-api03-AbCdEf0123456789xyz", "sk-ant-api03"],
    ["dcli_" + "A".repeat(43), "A".repeat(43)],
    ["dweb_" + "b".repeat(43), "b".repeat(43)],
    // P5-03: a paired device's credential, a pairing code in its link.
    ["ddev_" + "c".repeat(43), "c".repeat(43)],
    ["https://10.0.0.2:29600/#pair=7K3QD-9XWTB", "7K3QD-9XWTB"],
    ["open http://127.0.0.1:29200/#code=Zm9vYmFyYmF6", "Zm9vYmFyYmF6"],
    ["https://x.example/cb?state=1&code=4/0AbCdEf&scope=a", "4/0AbCdEf"],
    ['{"pin":"' + PIN + '","x":1}', PIN],
    ["pin=" + PIN, PIN],
    ["oldPin: 135799", "135799"],
    ['{"apiKey": "plain-key-value"}', "plain-key-value"],
    ["ANTHROPIC_API_KEY=whatever-it-is", "whatever-it-is"],
    ["daisy-pin-grant: Zm9vYmFyYmF6cXV4", "Zm9vYmFyYmF6cXV4"],
    ["postgres://user:hunter2hunter2@db/x", "hunter2hunter2"],
    ["ghp_" + "x".repeat(36), "x".repeat(36)],
    ["password = 'correct horse'", "correct horse"],
  ];
  for (const [text, secret] of cases) {
    const out = redact(text);
    assert.ok(!out.includes(secret), `${text} → ${out}`);
    assert.ok(out.includes(MASK), out);
  }
  for (const ok of [
    "会话 7f3c2a1e-0b8c-4c55-9a3e-2c1d0e9f8a7b 已开始",
    "exit code 3",
    "trace=4bf92f3577b34da6a3ce929d0e0e4736",
    "max_tokens: 4096, input_tokens: 12",
    '{"pinned":true,"pin":false,"code":"pin_required"}',
    "PIN 连续输错 5 次，已锁定",
  ])
    assert.equal(redact(ok), ok);
  // Exact values: any registered secret, wherever it sits.
  const v = "opaque-" + randomBytes(8).toString("hex");
  registerSecret(v);
  assert.equal(redact(`x${v}y`), `x${MASK}y`);
  // Short values are not registered (they would mask ordinary words).
  registerSecret("abc");
  assert.equal(redact("abc"), "abc");
});

test("S-1: logs, error answers and the audit hold no credential, token, PIN, code or API key", async () => {
  const dir = mkdtempSync(join(tmpdir(), "daisy-s1-"));
  // Everything written to standard output and error, as written.
  const written: string[] = [];
  const realOut = process.stdout.write.bind(process.stdout),
    realErr = process.stderr.write.bind(process.stderr);
  const tap =
    (real: typeof realOut) =>
    (chunk: any, ...rest: any[]) => {
      written.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return real(chunk, ...rest);
    };
  process.stdout.write = tap(realOut) as any;
  process.stderr.write = tap(realErr) as any;
  const lines: string[] = [];
  const offLog = onLog((l) => lines.push(l.text));
  // What libraries print goes through the same redaction (main.ts does this).
  installConsoleRedaction();
  const answers: string[] = [];
  const secrets: Record<string, string> = {};
  let ctx: Awaited<ReturnType<typeof createApp>> | undefined;
  let iss: Awaited<ReturnType<typeof fakeIssuer>> | undefined;
  // A shared machine (the passcode applies) — except while the loopback
  // http issuer is configured (review M-3 refuses one on a shared machine).
  let shared = true;
  try {
    // The real PinService (P1-05) behind the real routes.
    ctx = await createApp({
      dataDir: dir,
      workspaceHome: dir,
      workspaceRoots: [dir],
      sharedHost: () => shared,
    });
    // An internal error whose message carries a secret (registered before
    // the first request: Fastify takes no routes after that).
    const boomKey = "sk-ant-api03-" + randomBytes(24).toString("base64url");
    secrets.boomKey = boomKey;
    // A public route of its own (the guard lets only table routes through).
    serve(ctx.app, { ...api.system.health, id: "test.boom", path: "/api/__s1_boom", audit: false } as any, async () => {
      throw new Error(`upstream refused key ${boomKey} with Authorization: Bearer ${boomKey}`);
    });
    const inject = runnerInject(ctx.app, ctx.runnerApi);
    const go = async (o: any) => {
      const r = await inject(o);
      if (r.statusCode >= 400) answers.push(r.body, JSON.stringify((r as any).headers ?? {}));
      return r;
    };
    const cli = readFileSync(join(dir, "keys", "cli-credential"), "utf8").trim();
    secrets.cli = cli;
    const C = { authorization: `Bearer ${cli}` };
    const A0 = (t: string) => ({ authorization: `Bearer ${t}` });
    const nodeId = JSON.parse(readFileSync(join(dir, "runner.json"), "utf8")).nodeId;

    // ── the web page: one-time codes, sessions, the passcode ────────────
    const oc = (await go({ method: "POST", url: "/api/web/open-code", headers: C, payload: {} })).json();
    secrets.code = oc.code;
    const ws = await go({ method: "POST", url: "/api/web/session", payload: { code: oc.code } });
    const web = ws.json().token;
    secrets.web = web;
    const W = { authorization: `Bearer ${web}` };
    await go({ method: "POST", url: "/api/web/session", payload: { code: oc.code } }); // used up
    await go({ method: "POST", url: "/api/web/session", payload: { code: "x".repeat(22) } });
    await go({ method: "POST", url: "/api/web/session", payload: {} }); // passcode required
    await go({ url: "/api/sessions", headers: { authorization: `Bearer ${web}x` } });
    await go({ url: "/api/sessions", headers: { authorization: `Bearer ${cli.slice(0, -2)}zz` } });
    await go({ url: "/api/sessions", headers: { ...W, origin: "http://evil.example" } });

    // ── the PIN and its grant (P1-05's routes) ─────────────────────────
    const P = api.pin;
    const set = await go({ method: "POST", url: P.pinSet.path, headers: W, payload: { pin: PIN } });
    assert.equal(set.statusCode, 200, set.body);
    await go({ method: "POST", url: P.pinSet.path, headers: W, payload: { pin: "13579135", oldPin: "000000" } });
    const g = await go({ method: "POST", url: P.pinGrant.path, headers: W, payload: { pin: PIN } });
    assert.equal(g.statusCode, 200, g.body);
    secrets.grant = g.json().grant;
    assert.match(secrets.grant, /^[A-Za-z0-9_-]{43}$/);
    await go({ method: "POST", url: P.pinGrant.path, headers: W, payload: { pin: "999999" } });
    await go({ method: "POST", url: P.pinGrant.path, headers: A0(cli), payload: { pin: PIN } });
    await go({ method: "PUT", url: "/api/access/passcode", headers: W, payload: { mode: "on" } });
    await go({
      method: "PUT",
      url: "/api/access/passcode",
      headers: { ...W, [PIN_GRANT_HEADER]: secrets.grant + "x" },
      payload: { mode: "on" },
    });
    await go({
      method: "PUT",
      url: "/api/access/passcode",
      headers: { ...W, [PIN_GRANT_HEADER]: secrets.grant },
      payload: { mode: "on" },
    });
    await go({
      method: "PUT",
      url: "/api/access/passcode",
      headers: { ...C, [PIN_GRANT_HEADER]: secrets.grant },
      payload: { mode: "auto" },
    });

    // ── an identity with an API key; a harness's fake login ─────────────
    const apiKey = "sk-ant-api03-" + randomBytes(30).toString("base64url");
    secrets.apiKey = apiKey;
    const keyed = await go({
      method: "POST",
      url: "/api/profiles",
      headers: W,
      payload: { agent: "claude", nodeId, label: "keyed", authMode: "apiKey", apiKey },
    });
    assert.equal(keyed.statusCode, 200, keyed.body);
    const managed = (
      await go({ method: "POST", url: "/api/identities", headers: W, payload: { agent: "claude", nodeId, label: "isolated" } })
    ).json();
    const login = (await go({ method: "POST", url: `/api/profiles/${managed.id}/login`, headers: W, payload: {} })).json();
    const rh = runnerHeaders(nodeId);
    const claimedLogin = (await go({ method: "POST", url: "/api/runner/logins/claim", headers: rh, payload: {} })).json().login;
    const lh = { ...rh, "x-lease": claimedLogin.lease };
    const oauthState = randomBytes(12).toString("hex");
    await go({
      method: "POST",
      url: `/api/runner/logins/${login.id}/update`,
      headers: lh,
      payload: {
        status: "waiting",
        url: `https://claude.ai/oauth/authorize?code=true&state=${oauthState}`,
        needsInput: true,
      },
    });
    const loginCode = "CODE-" + randomBytes(16).toString("base64url") + "#" + oauthState;
    secrets.loginCode = loginCode;
    await go({ method: "POST", url: `/api/logins/${login.id}/input`, headers: W, payload: { code: loginCode } });
    const pulse = (await go({ method: "POST", url: `/api/runner/logins/${login.id}/pulse`, headers: lh, payload: {} })).json();
    assert.equal(pulse.code, loginCode, "the Runner gets the code (in process)");
    await go({
      method: "POST",
      url: `/api/runner/logins/${login.id}/update`,
      headers: lh,
      payload: { status: "failed", error: `harness said: bad code ${loginCode}` },
    });
    await go({ method: "POST", url: `/api/logins/${login.id}/input`, headers: W, payload: { code: loginCode } });

    // ── the AI's working credential ─────────────────────────────────────
    const cat = (await go({ url: "/api/catalog", headers: W })).json();
    const mk = async () =>
      (
        await go({
          method: "POST",
          url: "/api/sessions",
          headers: W,
          payload: {
            agent: "claude",
            workspaceId: cat.workspaces[0].id,
            profileId: keyed.json().id,
          },
        })
      ).json();
    const own = await mk(),
      other = await mk();
    await go({
      method: "POST",
      url: `/api/sessions/${own.id}/messages`,
      headers: W,
      payload: { text: "hi", requestId: "req-s1-00000001" },
    });
    const claimed = (await go({ method: "POST", url: "/api/runner/claim", headers: rh, payload: {} })).json();
    assert.equal(claimed.job.profile.apiKey, apiKey, "the key reaches the Runner (in process only)");
    const ai = readFileSync(claimed.job.aiCredential.file, "utf8").trim();
    secrets.ai = ai;
    const A = { authorization: `Bearer ${ai}` };
    await go({ url: `/api/sessions/${own.id}`, headers: A });
    await go({ url: `/api/sessions/${other.id}`, headers: A });
    await go({ url: "/api/audit", headers: A });
    await go({ method: "POST", url: `/api/sessions/${own.id}/messages`, headers: A, payload: { text: "x", requestId: "req-s1-00000002" } });
    await go({ url: "/api/sessions", headers: { authorization: `Bearer ${ai.slice(0, -4)}AAAA` } });

    // ── P2-01 / P2-02: an external issuer, its tokens, a token for the AI ─
    iss = await fakeIssuer();
    shared = false;
    const urn = ctx.access.ai.urn;
    const ownerToken = await iss.sign({ sub: "user:owner", aud: urn, scope: "daisy:session:read tasks:read" });
    secrets.ownerToken = ownerToken;
    const conf = await go({
      method: "PUT",
      url: "/api/access/issuer",
      headers: { ...W, [PIN_GRANT_HEADER]: secrets.grant },
      payload: { issuer: iss.issuer, ownerSubject: "user:owner", ownerToken },
    });
    assert.equal(conf.statusCode, 200, conf.body);
    iss.state.clients.set(conf.json().issuer.clientId, conf.json().self.jwk);
    const issuerOwner = await iss.sign({ sub: "user:owner", aud: urn });
    secrets.issuerOwner = issuerOwner;
    assert.equal((await go({ url: "/api/sessions", headers: A0(issuerOwner) })).statusCode, 200);
    const visitor = await iss.sign({ sub: "user:other", aud: urn });
    secrets.visitor = visitor;
    await go({ url: "/api/sessions", headers: A0(visitor) });
    const expired = await iss.sign({ sub: "user:owner", aud: urn, exp: 1000 }, { iat: 900 });
    secrets.expired = expired;
    await go({ url: "/api/sessions", headers: A0(expired) });
    const aiTok = await go({ method: "POST", url: `/api/sessions/${own.id}/ai-token`, headers: A, payload: { audience: "https://x.example", scope: "tasks:read" } });
    assert.equal(aiTok.statusCode, 200, aiTok.body);
    secrets.aiToken = aiTok.json().token;
    // An issuer that answers with a token Daisy refuses: the AI is told, the token is nowhere.
    iss.state.misbehave = { sub: "user:intruder" };
    const refused = await go({ method: "POST", url: `/api/sessions/${own.id}/ai-token`, headers: A, payload: { audience: "https://y.example", scope: "tasks:read" } });
    assert.equal(refused.statusCode, 502);
    iss.state.misbehave = null;
    shared = true;
    // The harness's tools with the turn.
    const call = ctx.runnerApi(nodeId);
    await call(`/sessions/${own.id}/schedules`, { jobId: claimed.job.id, kind: "wakeup", delaySeconds: 600, prompt: "later" });
    await call(`/sessions/${own.id}/schedules/no-such/cancel`, {}).catch(() => {});

    // ── error paths with a secret in the message ────────────────────────
    const boom = await go({ url: "/api/__s1_boom" });
    assert.equal(boom.statusCode, 500);
    // A Runner call that fails inside (the port logs the message).
    const port = new RunnerPort();
    port.post("/__s1_fail", async () => {
      throw new Error(`token ${ai} rejected; key=${apiKey}`);
    });
    await port.connect(nodeId)("/__s1_fail", {}).catch(() => {});
    // A handler's own error answer quoting a secret it was handed.
    await go({ method: "PATCH", url: `/api/sessions/${own.id}`, headers: W, payload: { title: 42, apiKey } });

    // ── careless log lines, Daisy's and a library's ─────────────────────
    log.error("debug dump", { cli, web, ai, grant: secrets.grant, code: oc.code, apiKey, loginCode });
    log.error(`tokens ${secrets.ownerToken} ${secrets.aiToken} ${secrets.issuerOwner}`);
    log.warn(`retrying with Authorization: Bearer ${web} and pin=${PIN}`);
    log.info(`{"pin":"${PIN}","oldPin":"${PIN}"}`);
    console.log("lib:", cli, web, ai, apiKey, secrets.aiToken, secrets.ownerToken);
    console.error(new Error(`failed: ${loginCode} ${secrets.grant}`));
    console.warn(`daisy-pin-grant: ${secrets.grant}`);

    // ── collect ──────────────────────────────────────────────────────────
    const auditRows = JSON.stringify(ctx.store.all("SELECT * FROM audit")) +
      JSON.stringify(ctx.store.all("SELECT * FROM audit_context"));
    const views =
      (await inject({ url: "/api/audit?limit=500", headers: C })).body +
      (await inject({ url: "/api/logs?limit=1000", headers: C })).body;
    const files: string[] = [];
    const walk = (d: string) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.log$/.test(n)) files.push(readFileSync(p, "utf8"));
      }
    };
    walk(dir);
    const corpus: Record<string, string> = {
      "stdout/stderr": written.join(""),
      "log lines": lines.join("\n"),
      audit: auditRows,
      "error answers": answers.join("\n"),
      "owner's views": views,
      "*.log files": files.join("\n"),
    };
    // The scenario did produce noise, and the masking did happen.
    assert.ok(lines.length >= 6, `日志太少：${lines.length}`);
    assert.ok(corpus["log lines"]!.includes(MASK));
    assert.ok(corpus["stdout/stderr"]!.includes(MASK));
    assert.ok(JSON.parse(auditRows.split("][")[0] + "]").length >= 20, "审计太少");
    const values = { ...secrets, pin: PIN };
    for (const [where, text] of Object.entries(corpus))
      for (const [name, value] of Object.entries(values))
        assert.ok(!text.includes(value), `S-1：${name} 出现在 ${where} 里`);
    // No shape of a secret either.
    for (const [where, text] of Object.entries(corpus)) {
      assert.doesNotMatch(text, /\bd(?:cli|web)_[A-Za-z0-9_-]{8,}/, where);
      assert.doesNotMatch(text, /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/, where);
      assert.doesNotMatch(text, /\bsk-[A-Za-z0-9_-]{12,}/, where);
    }
  } finally {
    offLog();
    process.stdout.write = realOut as any;
    process.stderr.write = realErr as any;
    await ctx?.app.close();
    await iss?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("S-1: Daisy's code logs only through observe/log.ts (no console.* in packages/daisy or a plugin package)", () => {
  const root = join(import.meta.dirname, "..", "packages");
  const allowed = new Set([
    // Writes its protocol answer (JSON) to its parent on stdout: not a log.
    "daisy/src/turns/claude-session.ts",
    // The log module itself.
    "daisy/src/observe/log.ts",
  ]);
  const bad: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (n === "node_modules") continue;
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|mjs|cjs|js)$/.test(n)) {
        const rel = p.slice(root.length + 1).replaceAll("\\", "/");
        if (allowed.has(rel)) continue;
        const text = readFileSync(p, "utf8");
        text.split("\n").forEach((l, i) => {
          if (/\bconsole\.(log|error|warn|info|debug|trace)\b/.test(l) && !/^\s*(\*|\/\/)/.test(l))
            bad.push(`${rel}:${i + 1}`);
        });
      }
    }
  };
  walk(join(root, "daisy"));
  // P4-13: plugin packages (they run inside Daisy: a peer dependency on
  // @daisy-ai/daisy) present in this checkout log the same way.
  for (const p of readdirSync(root)) {
    const manifest = join(root, p, "package.json");
    if (!existsSync(manifest) || !existsSync(join(root, p, "src"))) continue;
    if (JSON.parse(readFileSync(manifest, "utf8")).peerDependencies?.["@daisy-ai/daisy"]) walk(join(root, p, "src"));
  }
  assert.deepEqual(bad, [], "改用 observe/log.ts 的 log.info / log.warn / log.error");
});
