// N-9 (C-1 device acceptance, ADR-133): `claude auth status --json` failing
// in different ways says different things — a timeout, a keychain the
// process may not read, a CLI that will not start, not logged in, anything
// else (with a short redacted excerpt) — instead of always 「未登录或登录已过期」.
// A passing failure is asked once more; nothing is cached; the daemon log
// gets the redacted stderr and exit code; `daisy doctor` checks the
// Daisy-managed identities with the same classifier.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runClaude } from "../packages/daisy/src/harness/claude.ts";
import {
  AUTH_MESSAGES,
  AUTH_TIMING,
  checkClaudeAuth,
  classifyClaudeAuth,
  claudeAuthMessage,
  probeOf,
} from "../packages/daisy/src/harness/claude-auth.ts";
import { onLog } from "../packages/daisy/src/observe/log.ts";
import type { Runtime } from "../packages/daisy/src/harness/shared.ts";
import { daisy, testIo } from "./cli-fixture.ts";

const FIXTURE = resolve("tests/fixtures/agent.cjs");
const TOKEN = "sk-ant-oat01-abcdefghijklmnopqrstuvwxyz";

test("classifyClaudeAuth: each way the check ends has its own kind and message", () => {
  const ok = JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "max" });
  assert.deepEqual(classifyClaudeAuth({ code: 0, stdout: ok, stderr: "" }), { kind: "ok", plan: "max" });
  // Timeout.
  const t = classifyClaudeAuth({ code: null, stdout: "", stderr: "", timedOut: true });
  assert.equal(t.kind, "timeout");
  assert.match(claudeAuthMessage(t), /检查 Claude 登录超时（网络或钥匙串没有响应）/);
  // The CLI would not start.
  const m = classifyClaudeAuth({ code: null, stdout: "", stderr: "", spawnError: "ENOENT" });
  assert.equal(m.kind, "missing");
  assert.match(claudeAuthMessage(m), /找不到或不能运行 claude/);
  // A keychain error, exit non-zero.
  for (const stderr of [
    "security: SecKeychainSearchCopyNext: User interaction is not allowed. (-25308)",
    "Error: failed to read credentials from keychain",
  ]) {
    const k = classifyClaudeAuth({ code: 1, stdout: "", stderr });
    assert.equal(k.kind, "keychain", stderr);
    assert.match(claudeAuthMessage(k), /读取钥匙串失败：Daisy 进程可能没有访问钥匙串的权限（例如在受限的终端里启动）。在你自己的终端里运行 daisy stop && daisy start 再试/);
  }
  // Not logged in (Claude exits 1 with JSON): the message as before.
  const out = classifyClaudeAuth({ code: 1, stdout: JSON.stringify({ loggedIn: false }), stderr: "" }, { platform: "linux" });
  assert.equal(out.kind, "not-logged-in");
  assert.equal(claudeAuthMessage(out), "Claude 订阅身份未登录或登录已过期。请打开设置 → 连接你的 Agent 账号完成授权。");
  // An API key / another provider: not a subscription.
  for (const a of [{ loggedIn: true, authMethod: "api_key" }, { loggedIn: true, authMethod: "claude.ai", apiProvider: "bedrock" }])
    assert.equal(classifyClaudeAuth({ code: 0, stdout: JSON.stringify(a), stderr: "" }).kind, "not-subscription");
  // Anything else: generic, with a short excerpt — no token, no e-mail.
  const g = classifyClaudeAuth({
    code: 2,
    stdout: "",
    stderr: `fatal: refresh failed for owner@example.com with token ${TOKEN}\n${"x".repeat(500)}`,
  });
  assert.equal(g.kind, "failed");
  const msg = claudeAuthMessage(g);
  assert.match(msg, /^检查 Claude 登录失败（退出码 2：fatal: refresh failed/);
  assert.ok(!msg.includes(TOKEN) && !msg.includes("owner@example.com") && !msg.includes("sk-ant"), msg);
  assert.ok(msg.length < 260, msg);
  assert.equal(classifyClaudeAuth({ code: 0, stdout: "Usage: claude", stderr: "" }).kind, "failed");
  // execFile errors as probes.
  assert.deepEqual(probeOf({ code: "ENOENT" }), { code: null, stdout: "", stderr: "", spawnError: "ENOENT" });
  assert.equal(probeOf({ killed: true, signal: "SIGTERM", code: null }).timedOut, true);
  assert.equal(probeOf({ code: 1, stderr: "e" }).code, 1);
});

test("classifyClaudeAuth (macOS): 「not logged in」 for an identity that records an account points at the keychain", () => {
  const dir = mkdtempSync(join(tmpdir(), "daisy-auth-"));
  try {
    const loggedOut = { code: 1, stdout: JSON.stringify({ loggedIn: false }), stderr: "" };
    assert.equal(classifyClaudeAuth(loggedOut, { platform: "darwin", configDir: dir }).kind, "not-logged-in");
    writeFileSync(join(dir, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "owner@example.com" } }));
    const v = classifyClaudeAuth(loggedOut, { platform: "darwin", configDir: dir });
    assert.equal(v.kind, "keychain-suspect");
    assert.equal(claudeAuthMessage(v), AUTH_MESSAGES.keychainSuspect);
    assert.ok(!claudeAuthMessage(v).includes("owner@example.com"));
    // Not on Linux (credentials are a file there).
    assert.equal(classifyClaudeAuth(loggedOut, { platform: "linux", configDir: dir }).kind, "not-logged-in");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("checkClaudeAuth: a passing failure is asked once more after the wait; a definite answer is not; nothing is cached", async () => {
  const waits: number[] = [];
  const sleep = async (ms: number) => void waits.push(ms);
  const ok = { code: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }), stderr: "" };
  const script = (...probes: any[]) => {
    let i = 0;
    const run = async () => probes[Math.min(i++, probes.length - 1)];
    return { run, calls: () => i };
  };
  let s = script({ code: null, stdout: "", stderr: "", timedOut: true }, ok);
  assert.equal((await checkClaudeAuth(s.run, { sleep })).kind, "ok");
  assert.equal(s.calls(), 2);
  assert.deepEqual(waits, [AUTH_TIMING.retryMs]);
  assert.equal(AUTH_TIMING.retryMs, 2000);
  s = script({ code: null, stdout: "", stderr: "", timedOut: true });
  assert.equal((await checkClaudeAuth(s.run, { sleep })).kind, "timeout");
  assert.equal(s.calls(), 2, "two tries, then the turn fails");
  s = script({ code: 1, stdout: JSON.stringify({ loggedIn: false }), stderr: "" });
  assert.equal((await checkClaudeAuth(s.run, { sleep, platform: "linux" })).kind, "not-logged-in");
  assert.equal(s.calls(), 1, "not logged in is an answer, not asked again");
  s = script({ code: null, stdout: "", stderr: "", spawnError: "ENOENT" });
  assert.equal((await checkClaudeAuth(s.run, { sleep })).kind, "missing");
  assert.equal(s.calls(), 1);
  // A failure is not remembered: the next check asks again and passes.
  s = script({ code: 1, stdout: "", stderr: "keychain locked" }, { code: 1, stdout: "", stderr: "keychain locked" }, ok);
  assert.equal((await checkClaudeAuth(s.run, { sleep })).kind, "keychain");
  assert.equal((await checkClaudeAuth(s.run, { sleep })).kind, "ok");
});

/** One Claude turn on the fake CLI with a subscription identity. */
async function turn(env: Record<string, string>, configDir?: string) {
  const dir = mkdtempSync(join(tmpdir(), "daisy-auth-turn-"));
  const authLog = join(dir, "auth.log");
  const set: Record<string, string> = {
    DAISY_CLAUDE_BIN: FIXTURE,
    DAISY_FIXTURE_AUTH_LOG: authLog,
    ...env,
  };
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(set)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  const lines: string[] = [];
  const off = onLog((l) => lines.push(l.text));
  const events: any[] = [];
  try {
    const rt: Runtime = {
      job: {
        id: "j1",
        session: { id: "s1", agent: "claude", nativeId: null },
        profile: { id: "p-managed", authMode: "subscription", label: "身份", ...(configDir ? { configDir } : {}) },
        attachments: [],
      } as any,
      cwd: process.cwd(),
      prompt: "Hello",
      files: [],
      signal: new AbortController().signal,
      emit: (type, data) => events.push({ type, data }),
      flush: async () => {},
      approve: async () => ({ optionId: "allow" }),
    };
    let error: Error | null = null;
    try {
      await runClaude(rt);
    } catch (e) {
      error = e as Error;
    }
    let calls = 0;
    try {
      calls = readFileSync(set.DAISY_FIXTURE_AUTH_LOG!, "utf8").trim().split("\n").length;
    } catch {}
    return { error, calls, lines, events };
  } finally {
    off();
    for (const [k, v] of Object.entries(saved))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("Claude turn preflight (fake CLI): timeout / keychain / not logged in / other each fail with their own message; the log keeps the redacted stderr", async () => {
  const timing = { ...AUTH_TIMING };
  AUTH_TIMING.timeoutMs = 1500;
  AUTH_TIMING.retryMs = 20;
  try {
    let r = await turn({ DAISY_FIXTURE_AUTH_STATUS: "hang" });
    assert.match(r.error?.message ?? "", /检查 Claude 登录超时（网络或钥匙串没有响应）/);
    assert.equal(r.calls, 2, "a timeout is retried once");
    assert.ok(r.lines.some((l) => /Claude sign-in check \(identity p-managed, attempt 2\): timeout/.test(l)), r.lines.join("\n"));

    r = await turn({ DAISY_FIXTURE_AUTH_STATUS: "keychain" });
    assert.match(r.error?.message ?? "", /读取钥匙串失败：Daisy 进程可能没有访问钥匙串的权限/);
    assert.match(r.error?.message ?? "", /daisy stop && daisy start/);
    assert.equal(r.calls, 2);
    assert.ok(r.lines.some((l) => /keychain; exit code 1; stderr: security: SecKeychainSearchCopyNext: User interaction is not allowed/.test(l)), r.lines.join("\n"));

    r = await turn({ DAISY_FIXTURE_AUTH_STATUS: "loggedout" });
    assert.equal(r.error?.message, AUTH_MESSAGES.notLoggedIn);
    assert.equal(r.calls, 1, "not logged in is not retried");

    r = await turn({ DAISY_FIXTURE_AUTH_STATUS: "garbage" });
    assert.match(r.error?.message ?? "", /^检查 Claude 登录失败（退出码 2：fatal: refresh failed for \[redacted\] with token \[redacted\]/);
    const all = [r.error?.message ?? "", ...r.lines].join("\n");
    assert.ok(!all.includes(TOKEN) && !all.includes("owner@example.com"), all);
    assert.ok(r.lines.some((l) => /failed; exit code 2; stderr: fatal: refresh failed/.test(l)));

    // A passing keychain error then success: the turn goes on (retried once).
    r = await turn({ DAISY_FIXTURE_AUTH_STATUS: "keychain|ok" });
    assert.equal(r.error, null, String(r.error?.message));
    assert.equal(r.calls, 2);
    assert.ok(r.events.some((e) => e.type === "item" && /订阅身份已确认/.test(JSON.stringify(e.data))));

    // Nothing cached: a failed turn, then the next one checks again and runs.
    const dir = mkdtempSync(join(tmpdir(), "daisy-auth-seq-"));
    try {
      const shared = join(dir, "auth.log");
      r = await turn({ DAISY_FIXTURE_AUTH_STATUS: "loggedout|ok", DAISY_FIXTURE_AUTH_LOG: shared });
      assert.equal(r.error?.message, AUTH_MESSAGES.notLoggedIn);
      r = await turn({ DAISY_FIXTURE_AUTH_STATUS: "loggedout|ok", DAISY_FIXTURE_AUTH_LOG: shared });
      assert.equal(r.error, null, String(r.error?.message));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    Object.assign(AUTH_TIMING, timing);
  }
});

test("daisy doctor: checks each Daisy-managed Claude identity with the same classifier, without account details", async () => {
  const root = mkdtempSync(join(tmpdir(), "daisy-doctor-auth-"));
  const data = join(root, "data");
  mkdirSync(join(data, "keys"), { recursive: true, mode: 0o700 });
  writeFileSync(join(data, "runner.json"), JSON.stringify({ nodeId: "node-1" }), { mode: 0o600 });
  const ids = ["aaaaaaaa-ok", "bbbbbbbb-out", "cccccccc-key", "dddddddd-slow"];
  for (const id of ids) {
    const d = join(data, "runner", "node-1", id);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "owner@example.com" } }));
  }
  // A Codex identity directory (no .claude.json) is not checked.
  mkdirSync(join(data, "runner", "node-1", "eeeeeeee-codex"), { recursive: true });
  const bin = join(root, "fake-claude");
  writeFileSync(bin, "#!/bin/sh\n", { mode: 0o755 });
  try {
    const seen: { dir?: string; apiKey?: string }[] = [];
    const io = testIo({
      platform: "linux",
      env: {
        DAISY_CLAUDE_BIN: bin,
        DAISY_CODEX_BIN: join(root, "none"),
        DAISY_KIMI_BIN: join(root, "none"),
        ANTHROPIC_API_KEY: "sk-ant-api03-hostkeyhostkeyhostkey",
      },
      exec: (cmd, args, opts) => {
        if (!cmd.endsWith("fake-claude")) return undefined;
        if (args[0] === "--version") return { code: 0, stdout: "2.1.326 (Claude Code)\n", stderr: "" };
        const dir = opts?.env?.CLAUDE_CONFIG_DIR;
        if (opts?.env && dir) seen.push({ dir, apiKey: opts.env.ANTHROPIC_API_KEY });
        const ok = { code: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", email: "owner@example.com" }), stderr: "" };
        if (!dir) return ok;
        if (dir.endsWith("-ok")) return ok;
        if (dir.endsWith("-out")) return { code: 1, stdout: JSON.stringify({ loggedIn: false }), stderr: "" };
        if (dir.endsWith("-key")) return { code: 1, stdout: "", stderr: "security: User interaction is not allowed. owner@example.com" };
        return { code: 143, stdout: "", stderr: "", timedOut: true };
      },
    });
    const r = await daisy(io, data, "doctor");
    assert.match(r.out, /✓ Claude 独立登录 aaaaaaaa：已登录（订阅）/);
    assert.match(r.out, /! Claude 独立登录 bbbbbbbb：Claude 订阅身份未登录或登录已过期/);
    assert.match(r.out, /! Claude 独立登录 cccccccc：读取钥匙串失败/);
    assert.match(r.out, /! Claude 独立登录 dddddddd：检查 Claude 登录超时/);
    assert.ok(!r.out.includes("eeeeeeee"));
    assert.ok(!io.seen().includes("owner@example.com"), "no account detail is printed");
    // Each identity's own directory; the host's API key is not handed down.
    assert.ok(seen.some((s) => s.dir!.endsWith("aaaaaaaa-ok")));
    assert.ok(seen.every((s) => s.apiKey === undefined));
    // The timed-out and keychain ones were asked twice; the others once.
    const count = (suffix: string) => seen.filter((s) => s.dir!.endsWith(suffix)).length;
    assert.deepEqual([count("-ok"), count("-out"), count("-key"), count("-slow")], [1, 1, 2, 2]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
