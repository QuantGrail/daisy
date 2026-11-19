/**
 * P4-11 (plan §5.5 「统一的能力清单」, ADR-131) — acceptance C-3: a harness
 * that does not declare an optional capability → the UI does not offer
 * it, the command line answers 「这个 AI 不支持 X」 with what to do
 * (non-zero exit), and the server refuses it with `capability_unsupported`.
 *
 * The fake harness is a node report built by `declareCapabilities` (the
 * hook P4-10's generic ACP config entries use) declaring a subset, put
 * where a Runner's heartbeat puts it (`nodes.capabilities.agentFeatures`).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../packages/daisy/src/app.ts";
import {
  type AgentFeature,
  AGENT_CAPABILITIES,
  OPTIONAL_FEATURES,
  REQUIRED_FEATURES,
  capabilitiesFor,
} from "../packages/contracts/src/agent-capabilities.ts";
import {
  AGENT_FEATURES,
  CAPABILITY_UNSUPPORTED,
  declareCapabilities,
  featureTitle,
  featuresFor,
  unsupportedFix,
  unsupportedMessage,
} from "../packages/contracts/src/agent-features.ts";
import { commandList } from "../packages/contracts/src/commands.ts";
import { canSteer, steerBlockReason } from "../packages/ui/src/queue-jump.ts";
import { canRewindFiles } from "../packages/ui/src/rewind-copy.ts";
import { runnerInject } from "./fixtures/runner-calls.ts";
import { packT, uiLang } from "./ui-pack.ts";

// ADR-159 §8: the UI helpers (queue-jump, rewind-copy) speak Chinese here.
uiLang("zh-CN");
import { daisy, testIo } from "./cli-fixture.ts";

/** The fake harness: rewind (history only) and usage, nothing else optional. */
const SUBSET = declareCapabilities("codex", {
  features: { rewind: "native", usage: "native" },
});
const report = (codex: any) => ({
  agentFeatures: { ...AGENT_CAPABILITIES, codex },
});

test("§5.5: every capability of the list has one key, a title, and the required four are always declared", () => {
  assert.deepEqual(
    [...AGENT_FEATURES].sort(),
    [...REQUIRED_FEATURES, ...OPTIONAL_FEATURES].sort(),
  );
  // P6-22: every title in both languages (the packs, not the key).
  for (const lang of ["zh-CN", "en"])
    for (const k of AGENT_FEATURES) {
      const title = featureTitle(k, packT(lang));
      assert.ok(title && !title.startsWith("ui-contracts."), `${lang} ${k}`);
    }
  for (const agent of ["claude", "codex", "kimi"] as const) {
    const m = featuresFor({ agentFeatures: AGENT_CAPABILITIES }, agent);
    for (const k of REQUIRED_FEATURES)
      assert.equal(m[k], "native", `${agent} ${k}`);
    for (const k of AGENT_FEATURES)
      assert.ok(["native", "fallback", "none"].includes(m[k]), `${agent} ${k}`);
  }
  const sub = featuresFor(report(SUBSET), "codex");
  for (const k of REQUIRED_FEATURES) assert.equal(sub[k], "native");
  assert.equal(sub.rewind, "native");
  assert.equal(sub.usage, "native");
  for (const k of OPTIONAL_FEATURES.filter(
    (k) => k !== "rewind" && k !== "usage",
  ))
    assert.equal(sub[k], "none", k);
});

test("§5.5 per harness and per CLI version: Claude Code, Codex, Kimi Code", () => {
  const at = (agent: "claude" | "codex" | "kimi", v?: string) =>
    featuresFor(
      { agentFeatures: { [agent]: capabilitiesFor(agent, v) } },
      agent,
    );
  const claude = at("claude", "2.1.330 (Claude Code)");
  assert.equal(claude.steer, "native");
  assert.equal(claude.withdraw, "native");
  assert.equal(claude.rewindFiles, "native");
  assert.equal(claude.askOnly, "native");
  assert.equal(claude.fork, "native");
  assert.equal(claude.compact, "native");
  assert.equal(claude.readOnly, "native");
  // Below the measured version: Daisy's plain-text steer, model live only.
  const old = at("claude", "2.1.100 (Claude Code)");
  assert.equal(old.steer, "fallback");
  assert.equal(old.withdraw, "none");
  assert.equal(old.model, "native");
  assert.equal(old.effort, "fallback");
  const codex = at("codex", "codex-cli 0.157.1");
  assert.equal(codex.rewindFiles, "fallback");
  assert.equal(codex.withdraw, "none");
  assert.equal(codex.askOnly, "native");
  const kimi = at("kimi", "kimi 2.6.2");
  assert.equal(kimi.steer, "none");
  assert.equal(kimi.rewindFiles, "none");
  assert.equal(kimi.fork, "native");
  assert.equal(kimi.quota, "none");
  assert.equal(kimi.model, "fallback"); // restart and resume
  // No report at all (an older Runner): this release's table, the fallback rule.
  assert.equal(featuresFor({}, "claude").rewindFiles, "native");
  assert.equal(featuresFor({}, "kimi").steer, "none");
  // An unknown harness nobody reported: nothing is offered.
  assert.equal(featuresFor({}, "nobody").fork, "none");
  assert.equal(featuresFor({}, "nobody").session, "none");
});

test("C-3 UI: an undeclared capability is not offered (slash menu, 立即追加, 同时撤销文件)", () => {
  const full = featuresFor(report(AGENT_CAPABILITIES.codex), "codex");
  const sub = featuresFor(report(SUBSET), "codex");
  const names = (f: any) => commandList("codex", [], f, packT("zh-CN")).map((c) => c.name);
  for (const n of [
    "fork",
    "compact",
    "rewind",
    "model",
    "permissions",
    "terminal",
  ])
    assert.ok(names(full).includes(n), n);
  const shown = names(sub);
  for (const n of ["fork", "compact", "model", "permissions", "terminal"])
    assert.ok(!shown.includes(n), `${n} hidden`);
  assert.ok(shown.includes("rewind"));
  assert.ok(shown.includes("help") && shown.includes("stop"));
  // No features (an older server): the menu as before.
  assert.ok(names(undefined).includes("fork"));

  const steer = {
    busy: true,
    terminalMode: false,
    editing: false,
    finished: 0,
    agent: "codex",
    hasText: true,
    attachments: 0,
  };
  assert.equal(canSteer({ ...steer, steer: full.steer }), true);
  assert.equal(canSteer({ ...steer, steer: sub.steer }), false);
  assert.match(
    steerBlockReason({ ...steer, steer: sub.steer })!,
    /不支持追加到本轮/,
  );
  // The old agent-name rule is now the declaration's (Kimi Code: none).
  assert.equal(canSteer({ ...steer, agent: "kimi" }), false);
  assert.equal(canSteer({ ...steer, agent: "claude" }), true);

  assert.equal(canRewindFiles("codex", full.rewindFiles), true);
  assert.equal(canRewindFiles("codex", sub.rewindFiles), false);
});

async function server() {
  const dir = mkdtempSync(join(tmpdir(), "daisy-features-"));
  const ctx = await createApp({
    pinGate: false,
    dataDir: dir,
    workspaceHome: dir,
    workspaceRoots: [dir],
    sharedHost: () => false,
    peerIsOwner: () => true,
  });
  const inject = runnerInject(ctx.app, ctx.runnerApi);
  const uh = { authorization: `Bearer ${ctx.issueToken()}` };
  const call = async (method: string, url: string, payload?: any) => {
    const r = await inject({
      method: method as any,
      url,
      payload,
      headers: uh,
    });
    return { status: r.statusCode, body: r.json() };
  };
  const cat = (await call("GET", "/api/catalog")).body;
  let p = cat.profiles.find((p: any) => p.agent === "codex");
  if (!p)
    p = (
      await call("POST", "/api/profiles", {
        label: "codex",
        nodeId: cat.nodes?.[0]?.id ?? ctx.store.one("SELECT id FROM nodes").id,
        agent: "codex",
        authMode: "subscription",
      })
    ).body;
  const s = (
    await call("POST", "/api/sessions", {
      title: "features",
      agent: "codex",
      profileId: p.id,
      workspaceId: cat.workspaces[0].id,
    })
  ).body;
  // A native conversation exists (so fork / rewind pass that check).
  const row = ctx.store.session(s.id)!;
  ctx.store.save({ ...row, nativeId: "thread-1" });
  const declare = (codex: any) =>
    ctx.store.run(
      "UPDATE nodes SET capabilities=? WHERE id=?",
      JSON.stringify(report(codex)),
      s.nodeId,
    );
  return { dir, ctx, call, s, declare };
}

test("C-3 server: the snapshot carries the declaration; an undeclared capability is refused with a clear error", async () => {
  const { dir, ctx, call, s, declare } = await server();
  try {
    declare(SUBSET);
    const snap = (await call("GET", `/api/sessions/${s.id}`)).body;
    assert.equal(snap.features.fork, "none");
    assert.equal(snap.features.rewind, "native");
    assert.equal(snap.features.session, "native");
    assert.equal(snap.rewindFiles, "none");

    let n = 0;
    const op = (name: string, args: any = {}) =>
      call("POST", `/api/sessions/${s.id}/operations`, {
        requestId: `features-${++n}-${name}`,
        name,
        args,
      });
    const refused = (r: any, k: AgentFeature) => {
      assert.equal(r.status, 409, JSON.stringify(r.body));
      assert.equal(r.body.code, CAPABILITY_UNSUPPORTED);
      assert.equal(r.body.error, unsupportedMessage("codex", k));
      assert.match(
        r.body.error,
        new RegExp(`不支持「${featureTitle(k, packT("zh-CN")).replace(/[()（）]/g, ".")}」`),
      );
      assert.ok(typeof r.body.fix === "string" && r.body.fix.length > 5);
    };
    refused(await op("fork"), "fork");
    refused(await op("compact"), "compact");
    refused(await op("rewind", { count: 1, files: true }), "rewindFiles");
    refused(
      await call("POST", `/api/sessions/${s.id}/operations/terminal`, {
        requestId: "features-terminal-1",
        name: "terminal",
      }),
      "terminal",
    );
    refused(
      await call("POST", `/api/sessions/${s.id}/steer`, {
        requestId: "features-steer-1",
        text: "也看看这个",
      }),
      "steer",
    );
    refused(
      await call("POST", `/api/sessions/${s.id}/queue/merge-steer`, {
        all: true,
      }),
      "steer",
    );
    refused(
      await call("PATCH", `/api/sessions/${s.id}`, {
        settings: { model: "gpt-5.5" },
      }),
      "model",
    );
    refused(
      await call("PATCH", `/api/sessions/${s.id}`, {
        settings: { reasoningEffort: "high" },
      }),
      "effort",
    );
    // Declared: rewind (history only) passes the declaration check.
    const ok = await op("rewind", { count: 1 });
    assert.notEqual(
      ok.body.code,
      CAPABILITY_UNSUPPORTED,
      JSON.stringify(ok.body),
    );
    // Nothing was queued for a refused one.
    assert.equal(
      ctx.store.one(
        "SELECT COUNT(*) n FROM job_operations o JOIN jobs j ON j.id=o.job_id WHERE j.session_id=? AND json_extract(o.data,'$.name') IN ('fork','compact','terminal')",
        s.id,
      ).n,
      0,
    );

    // The full declaration: the same calls get past the declaration.
    declare(AGENT_CAPABILITIES.codex);
    assert.equal(
      (await call("GET", `/api/sessions/${s.id}`)).body.features.fork,
      "native",
    );
    for (const r of [
      await op("fork"),
      await call("POST", `/api/sessions/${s.id}/steer`, {
        requestId: "features-steer-2",
        text: "x",
      }),
    ])
      assert.notEqual(
        r.body.code,
        CAPABILITY_UNSUPPORTED,
        JSON.stringify(r.body),
      );
  } finally {
    await ctx.app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("C-3 command line: 「这个 AI 不支持 X」 with what to do, exit code 1", async () => {
  const { dir, ctx, s, declare } = await server();
  try {
    declare(SUBSET);
    const url = await ctx.app.listen({ host: "127.0.0.1", port: 0 });
    writeFileSync(
      join(dir, "runtime.json"),
      JSON.stringify({
        pid: process.pid,
        release: "0.1.0+test",
        startedAt: Date.now(),
        dataDir: dir,
        local: { url, port: Number(new URL(url).port) },
        external: null,
        cliCredential: join(dir, "keys", "cli-credential"),
      }),
    );
    const io = testIo();
    const r = await daisy(io, dir, "session", "operation", "run", s.id, "fork");
    assert.equal(r.code, 1, r.err);
    assert.match(
      r.err,
      /✗ 这个 AI（Codex）不支持「分叉」：它的能力声明里没有这一项/,
    );
    assert.ok(
      r.err.includes(
        "怎么办：" +
          unsupportedFix("fork", featuresFor(report(SUBSET), "codex")),
      ),
      r.err,
    );
    const io2 = testIo();
    const r2 = await daisy(io2, dir, "session", "steer", s.id, "也看看这个");
    assert.equal(r2.code, 1, r2.err);
    assert.match(r2.err, /不支持「运行中追加（立即追加）」/);
    assert.match(r2.err, /怎么办：改用排队发送：daisy session send/);
    // No credential in what the person sees.
    const cred = readFileSync(
      join(dir, "keys", "cli-credential"),
      "utf8",
    ).trim();
    assert.ok(!(r.err + r.out + r2.err + r2.out).includes(cred));
  } finally {
    await ctx.app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the Runner reports the §5.5 declaration per agent and CLI version (heartbeat capabilities.agentFeatures)", async () => {
  const { resolve } = await import("node:path");
  const { capabilities } =
    await import("../packages/daisy/src/turns/worker.ts");
  for (const a of ["CLAUDE", "CODEX", "KIMI"])
    process.env[`DAISY_${a}_BIN`] = resolve("tests/fixtures/agent.cjs");
  try {
    process.env.DAISY_FIXTURE_CLI_VERSION = "2.1.316";
    const now = await capabilities();
    for (const a of ["claude", "codex", "kimi"]) {
      assert.equal(now.agentFeatures[a].features.session, "native", a);
      assert.ok(now.agentFeatures[a].readOnly, a);
    }
    assert.equal(featuresFor(now, "claude").steer, "native");
    assert.equal(featuresFor(now, "kimi").steer, "none");
    assert.equal(featuresFor(now, "kimi").fork, "native");
    assert.equal(now.agentFeatures.kimi.readOnly.opts.strength, "weak");
    process.env.DAISY_FIXTURE_CLI_VERSION = "2.0.0";
    const old = await capabilities();
    assert.equal(featuresFor(old, "claude").steer, "fallback");
    assert.equal(featuresFor(old, "claude").rewindFiles, "none");
  } finally {
    for (const k of [
      "DAISY_CLAUDE_BIN",
      "DAISY_CODEX_BIN",
      "DAISY_KIMI_BIN",
      "DAISY_FIXTURE_CLI_VERSION",
    ])
      delete process.env[k];
  }
});

test("P6-22: the refusal, what to do and the menu speak the given language (default: the process's)", () => {
  const en = packT("en"),
    zh = packT("zh-CN");
  assert.equal(
    unsupportedMessage("codex", "fork", en),
    'This AI (Codex) does not support "Fork": its capability declaration does not list it, and Daisy does not emulate it',
  );
  assert.match(unsupportedMessage("codex", "fork", zh), /^这个 AI（Codex）不支持「分叉」/);
  // The tests' process speaks Chinese (tests/test-env.mjs): the default translator follows it.
  assert.equal(unsupportedMessage("codex", "fork"), unsupportedMessage("codex", "fork", zh));
  assert.match(unsupportedFix("steer", null, en), /^Send it queued instead: daisy session send/);
  assert.match(unsupportedFix("model", null, en), /start a new session with an AI that declares "Switch the model"/);
  const menu = commandList("claude", [], null, en);
  assert.equal(menu.find((c) => c.name === "new")?.title, "New conversation");
  assert.equal(menu.find((c) => c.name === "identity")?.title, "Identity and model slots");
  assert.equal(commandList("codex", [], null, zh).find((c) => c.name === "review")?.title, "代码审阅");
});
