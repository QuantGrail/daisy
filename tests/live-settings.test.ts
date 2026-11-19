/**
 * model / effort / permission mode reach an online process before
 * the next turn without restarting it (capability `settings`, by CLI
 * version); bypass on / off and the Codex sandbox still restart; a mode that
 * cannot be applied ends the process instead of running the old one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createApp } from "../packages/daisy/src/app.ts";
import { runNode, type NodeConfig } from "../packages/daisy/src/turns/worker.ts";
import { DaisyClient } from "../packages/client/src/index.ts";
import type { Snapshot } from "../packages/contracts/src/index.ts";
import {
  AGENT_CAPABILITIES,
  capabilitiesFor,
  settingsRoute,
} from "../packages/contracts/src/agent-capabilities.ts";
import { liveKey } from "../packages/daisy/src/turns/live.ts";
import { setLiveSettings } from "../packages/daisy/src/harness/shared.ts";
import { codexModeOf } from "../packages/daisy/src/harness/codex.ts";
import { runnerConfig } from "./fixtures/runner-calls.ts";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(read: () => Promise<T>, accept: (x: T) => boolean) {
  for (let i = 0; i < 150; i++) {
    const x = await read();
    if (accept(x)) return x;
    await delay(100);
  }
  throw Error("State timed out");
}
const idle = (x: Snapshot) =>
  !["queued", "running", "waiting"].includes(x.session.status);
const jsonl = (f: string) =>
  existsSync(f)
    ? readFileSync(f, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];

test("settings capability: native from the measured CLI versions, legacy below; liveKey follows it; bypass and sandbox always restart", () => {
  assert.deepEqual(
    capabilitiesFor("claude", "2.1.316 (Claude Code)").settings,
    {
      model: "native",
      effort: "native",
      permissionMode: "native",
    },
  );
  assert.deepEqual(capabilitiesFor("claude", "2.1.315").settings, {
    model: "native",
    effort: "restart",
    permissionMode: "restart",
  });
  assert.deepEqual(capabilitiesFor("codex", "codex-cli 0.157.1").settings, {
    model: "native",
    effort: "native",
    permissionMode: "native",
  });
  assert.deepEqual(capabilitiesFor("codex", undefined).settings, {
    model: "restart",
    effort: "native",
    permissionMode: "restart",
  });
  assert.equal(capabilitiesFor("kimi", "9.9.9").settings!.model, "restart");
  // An older Runner (no `settings`) or garbage: legacy / restart.
  assert.equal(settingsRoute({ claude: {} }, "claude").effort, "restart");
  assert.equal(
    settingsRoute({ claude: { settings: { effort: "yes" } } }, "claude").effort,
    "restart",
  );

  const key = (agent: string, p: Record<string, unknown>) =>
    liveKey(
      {
        session: { agent, id: "s" },
        profile: { id: "p", agent, authMode: "subscription", ...p },
      } as any,
      "/w",
    );
  try {
    setLiveSettings(AGENT_CAPABILITIES);
    // Claude: model, effort, permission mode live …
    assert.equal(
      key("claude", {
        model: "a",
        reasoningEffort: "low",
        permissionMode: "default",
      }),
      key("claude", {
        model: "b",
        reasoningEffort: "high",
        permissionMode: "plan",
      }),
    );
    // … bypass on / off never.
    assert.notEqual(
      key("claude", { permissionMode: "default" }),
      key("claude", { permissionMode: "bypassPermissions" }),
    );
    // Codex: model / approval live; the sandbox, and bypass, restart.
    assert.equal(
      key("codex", {
        model: "a",
        permissionMode: "on-request",
        sandboxMode: "workspace-write",
      }),
      key("codex", {
        model: "b",
        permissionMode: "never",
        sandboxMode: "workspace-write",
      }),
    );
    assert.notEqual(
      key("codex", { sandboxMode: "workspace-write" }),
      key("codex", { sandboxMode: "read-only" }),
    );
    assert.notEqual(
      key("codex", {
        permissionMode: "on-request",
        sandboxMode: "danger-full-access",
      }),
      key("codex", {
        permissionMode: "never",
        sandboxMode: "danger-full-access",
      }),
    );
    // Kimi: all restart, as before.
    assert.notEqual(key("kimi", { model: "a" }), key("kimi", { model: "b" }));
    assert.notEqual(
      key("kimi", { permissionMode: "default" }),
      key("kimi", { permissionMode: "plan" }),
    );
    // An older CLI: what restarted before still restarts.
    setLiveSettings({
      claude: capabilitiesFor("claude", "2.0.0"),
      codex: capabilitiesFor("codex", "0.100.0"),
    });
    assert.notEqual(
      key("claude", { reasoningEffort: "low" }),
      key("claude", { reasoningEffort: "high" }),
    );
    assert.notEqual(
      key("claude", { permissionMode: "default" }),
      key("claude", { permissionMode: "plan" }),
    );
    assert.equal(key("claude", { model: "a" }), key("claude", { model: "b" }));
    assert.notEqual(key("codex", { model: "a" }), key("codex", { model: "b" }));
    assert.equal(
      key("codex", { reasoningEffort: "low" }),
      key("codex", { reasoningEffort: "high" }),
    );
  } finally {
    setLiveSettings(null);
  }
  assert.equal(
    codexModeOf({ approvalPolicy: "never", approvalsReviewer: "user" }),
    "never",
  );
  assert.equal(
    codexModeOf({
      approvalPolicy: "on-request",
      approvalsReviewer: "auto_review",
    }),
    "auto",
  );
  assert.equal(codexModeOf({ approvalPolicy: { granular: {} } }), undefined);
});

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "daisy-live-settings-"));
  const ctx = await createApp({ pinGate: false,
    workspaceHome: dir,
    workspaceRoots: [dir],
    dataDir: dir,
  });
  const url = await ctx.app.listen({ host: "127.0.0.1", port: 0 });
  const c = new DaisyClient(
    url,
    ctx.issueToken(),
  );
  const config: NodeConfig = {
    ...runnerConfig(ctx, join(dir, "runner.json")),
    // Spawn records are told apart by DAISY_TEST_SESSION (P4-13: the test-only plugin tests/plugins/session-tag).
    plugins: ["session-tag"],
  };
  const spawns = join(dir, "spawns.jsonl"),
    record = join(dir, "record.jsonl"),
    thread = join(dir, "thread.jsonl");
  for (const a of ["CLAUDE", "CODEX", "KIMI"])
    process.env[`DAISY_${a}_BIN`] = resolve("tests/fixtures/agent.cjs");
  process.env.DAISY_FIXTURE_ENV_FILE = spawns;
  process.env.DAISY_FIXTURE_RECORD = record;
  process.env.DAISY_FIXTURE_RECORD_THREAD = thread;
  // The CLI versions the live settings were measured on.
  process.env.DAISY_FIXTURE_CLI_VERSION = "2.1.316";
  // Codex's catalog (its default model: gpt-6-astra).
  process.env.DAISY_FIXTURE_CODEX_CATALOG = resolve(
    "tests/fixtures/codex-model-list.json",
  );
  config.identityRoot ??= join(dir, "runner-state-root");
  const controller = new AbortController();
  const worker = runNode(config, controller.signal);
  const cat = await c.catalog();
  const pid = (a: string) => cat.profiles.find((p) => p.agent === a)!.id;
  const create = (agent: "claude" | "codex", title: string) =>
    c.create({
      agent,
      title,
      profileId: pid(agent),
      workspaceId: cat.workspaces[0].id,
    });
  const turn = async (sid: string, text: string) => {
    await c.send(sid, text);
    const waiting = await until(
      () => c.snapshot(sid),
      (x) => x.approvals.some((a) => a.status === "pending") || idle(x),
    );
    const a = waiting.approvals.find((a) => a.status === "pending");
    if (a) await c.approve(sid, a.id, a.options[0].id);
    return until(
      () => c.snapshot(sid),
      (x) => idle(x) && !x.approvals.some((a) => a.status === "pending"),
    );
  };
  const started = (sid: string) =>
    jsonl(spawns).filter(
      (x) =>
        x.DAISY_TEST_SESSION === sid &&
        !x.argv.includes("auth") &&
        (x.argv.includes("-p") || x.argv.includes("app-server")),
    );
  // PATCH saves the model settings as a whole: carry model / effort along.
  const patchProfile = async (agent: string, body: object) => {
    const p = (await c.catalog()).profiles.find(
      (x) => x.agent === agent,
    ) as any;
    return c.request(`/profiles/${p.id}`, "PATCH", {
      model: p.model ?? "",
      reasoningEffort: p.reasoningEffort ?? "",
      ...body,
    });
  };
  const close = async () => {
    controller.abort();
    await worker.catch(() => {});
    await ctx.app.close();
    for (const k of [
      "DAISY_CLAUDE_BIN",
      "DAISY_CODEX_BIN",
      "DAISY_KIMI_BIN",
      "DAISY_FIXTURE_ENV_FILE",
      "DAISY_FIXTURE_RECORD",
      "DAISY_FIXTURE_RECORD_THREAD",
      "DAISY_FIXTURE_CLI_VERSION",
      "DAISY_FIXTURE_CODEX_CATALOG",
      "DAISY_FIXTURE_MODE_FAIL",
      "DAISY_FIXTURE_DROP_OVERRIDE",
      "DAISY_FIXTURE_RESUME_SAVED",
    ])
      delete process.env[k];
    rmSync(dir, { recursive: true, force: true });
  };
  return {
    c,
    create,
    turn,
    started,
    patchProfile,
    recorded: () => jsonl(record),
    threadLog: () => jsonl(thread),
    close,
  };
}

test(
  "Claude 2.1.316: effort and permission mode change live (apply_flag_settings / set_permission_mode), one process, the effective values shown; a mode that fails ends the process",
  { timeout: 60000 },
  async () => {
    process.env.DAISY_FIXTURE_MODE_FAIL = "acceptEdits";
    const t = await setup();
    try {
      const s = await t.create("claude", "live settings");
      await t.turn(s.id, "Hello");
      await until(
        () => t.c.snapshot(s.id),
        (x) => !!x.session.live?.online && !x.session.live.busy,
      );
      // Effort: live, the process kept; the value Claude Code applied shown.
      await t.c.updateSession(s.id, { settings: { reasoningEffort: "high" } });
      let snap = await t.turn(s.id, "Think harder");
      assert.equal(t.started(s.id).length, 1, "not restarted for effort");
      assert.ok(
        t
          .recorded()
          .some((r) => r.via === "apply_flag_settings" && r.text === "high"),
      );
      assert.equal(snap.session.runtime?.effort, "high");
      // Back to 默认: null, Claude Code reports the model's default.
      await t.c.updateSession(s.id, { settings: { reasoningEffort: "" } });
      snap = await t.turn(s.id, "Default effort");
      assert.ok(
        t
          .recorded()
          .some((r) => r.via === "apply_flag_settings" && r.text === "null"),
      );
      assert.equal(snap.session.runtime?.effort, "medium");
      // Permission mode: live, reported by the turn's init.
      await t.patchProfile("claude", { permissionMode: "plan" });
      snap = await t.turn(s.id, "Plan it");
      assert.equal(t.started(s.id).length, 1, "not restarted for the mode");
      assert.ok(
        t
          .recorded()
          .some((r) => r.via === "set_permission_mode" && r.text === "plan"),
      );
      assert.equal(snap.session.runtime?.permissionMode, "plan");
      // Review L4: the model leaves plan mode itself (approved ExitPlanMode
      // → acceptEdits, system/status); the next turn puts plan back.
      await t.turn(s.id, "EXIT_PLAN_TEST");
      snap = await t.turn(s.id, "After the plan");
      assert.equal(
        t
          .recorded()
          .filter((r) => r.via === "set_permission_mode" && r.text === "plan")
          .length,
        2,
      );
      assert.equal(snap.session.runtime?.permissionMode, "plan");
      assert.equal(t.started(s.id).length, 1);
      // A mode Claude Code refuses: the turn does not run with the old one;
      // the process ends and the next message starts with the new mode.
      // (The fake refuses acceptEdits: DAISY_FIXTURE_MODE_FAIL, set at launch.)
      await t.patchProfile("claude", { permissionMode: "acceptEdits" });
      snap = await t.turn(s.id, "Edit freely");
      assert.ok(
        snap.items.some((i) => /权限模式没能在线切换/.test(i.text || "")),
        "the failure is said",
      );
      assert.equal(
        t.recorded().filter((r) => String(r.text).includes("Edit freely"))
          .length,
        0,
        "the message never reached the Agent under the old mode",
      );
      await t.turn(s.id, "Again");
      const runs = t.started(s.id);
      assert.equal(runs.length, 2);
      assert.equal(
        runs[1].argv[runs[1].argv.indexOf("--permission-mode") + 1],
        "acceptEdits",
      );
    } finally {
      await t.close();
    }
  },
);

test(
  "Codex 0.157.1: model and permission mode ride turn/start (no restart), the thread's settings shown; the sandbox still restarts",
  { timeout: 60000 },
  async () => {
    // A resumed thread reports the model of its last overriding turn.
    process.env.DAISY_FIXTURE_RESUME_SAVED = JSON.stringify({
      model: "gpt-6-luna",
    });
    const t = await setup();
    try {
      const s = await t.create("codex", "live settings");
      await t.turn(s.id, "Hello");
      await until(
        () => t.c.snapshot(s.id),
        (x) => !!x.session.live?.online && !x.session.live.busy,
      );
      await t.c.updateSession(s.id, { settings: { model: "gpt-6-luna" } });
      let snap = await t.turn(s.id, "Another model");
      assert.equal(t.started(s.id).length, 1, "not restarted for the model");
      let last = t
        .threadLog()
        .filter((r) => r.via === "turn/start")
        .at(-1);
      assert.equal(last.model, "gpt-6-luna");
      assert.equal(snap.session.runtime?.model, "gpt-6-luna");
      // Unchanged next turn: nothing re-sent.
      await t.turn(s.id, "Same again");
      last = t
        .threadLog()
        .filter((r) => r.via === "turn/start")
        .at(-1);
      assert.equal(last.model, undefined);
      // 默认 again: the catalog's default model, explicitly.
      await t.c.updateSession(s.id, { settings: { model: "" } });
      await t.turn(s.id, "Default model");
      last = t
        .threadLog()
        .filter((r) => r.via === "turn/start")
        .at(-1);
      assert.equal(last.model, "gpt-6-astra");
      // Permission mode: approval policy / reviewer per turn.
      await t.patchProfile("codex", { permissionMode: "auto" });
      snap = await t.turn(s.id, "Review for me");
      last = t
        .threadLog()
        .filter((r) => r.via === "turn/start")
        .at(-1);
      assert.equal(last.approvalPolicy, "on-request");
      assert.equal(last.approvalsReviewer, "auto_review");
      assert.equal(snap.session.runtime?.permissionMode, "auto");
      await t.patchProfile("codex", { permissionMode: "untrusted" });
      snap = await t.turn(s.id, "Ask me first");
      last = t
        .threadLog()
        .filter((r) => r.via === "turn/start")
        .at(-1);
      assert.equal(last.approvalPolicy, "untrusted");
      assert.equal(last.approvalsReviewer, "user");
      assert.equal(snap.session.runtime?.permissionMode, "untrusted");
      assert.equal(t.started(s.id).length, 1, "one process throughout");
      // The sandbox is a launch setting: a new process.
      await t.patchProfile("codex", {
        permissionMode: "untrusted",
        sandboxMode: "read-only",
      });
      await t.turn(s.id, "Read only now");
      const runs = t.started(s.id);
      assert.equal(runs.length, 2);
      const start = t
        .threadLog()
        .filter((r) => r.via === "thread/resume")
        .at(-1);
      assert.equal(start.sandbox, "read-only");
      assert.equal(start.approvalPolicy, "untrusted");
      // Review L5: the resumed thread came back on the last per-turn model
      // (0.157.1 keeps it); with 默认 chosen, that turn sends the default.
      last = t
        .threadLog()
        .filter((r) => r.via === "turn/start")
        .at(-1);
      assert.equal(last.model, "gpt-6-astra");
    } finally {
      await t.close();
    }
  },
);

test(
  "Codex (review L1): an override Codex did not take is sent again — thread/settings/updated is the truth",
  { timeout: 60000 },
  async () => {
    process.env.DAISY_FIXTURE_DROP_OVERRIDE = "1";
    const t = await setup();
    try {
      const s = await t.create("codex", "dropped override");
      await t.turn(s.id, "Hello");
      await t.patchProfile("codex", { permissionMode: "untrusted" });
      let snap = await t.turn(s.id, "Ask me first");
      const starts = () => t.threadLog().filter((r) => r.via === "turn/start");
      assert.equal(starts().at(-1).approvalPolicy, "untrusted");
      assert.equal(snap.session.runtime?.permissionMode, "on-request");
      assert.ok(
        snap.items.some((i) => i.name === "Codex 没有切换权限模式：下一轮再试"),
      );
      snap = await t.turn(s.id, "Again");
      assert.equal(starts().at(-1).approvalPolicy, "untrusted", "sent again");
      assert.equal(snap.session.runtime?.permissionMode, "untrusted");
      await t.turn(s.id, "Once more");
      assert.equal(starts().at(-1).approvalPolicy, undefined, "then settled");
      assert.equal(t.started(s.id).length, 1);
    } finally {
      await t.close();
    }
  },
);

test("worker (review L2): a --version that fails keeps the last known settings features — no fall back to restarts", async () => {
  const { capabilities } = await import("../packages/daisy/src/turns/worker.ts");
  const { liveSettings } =
    await import("../packages/daisy/src/harness/shared.ts");
  for (const a of ["CLAUDE", "CODEX", "KIMI"])
    process.env[`DAISY_${a}_BIN`] = resolve("tests/fixtures/agent.cjs");
  process.env.DAISY_FIXTURE_CLI_VERSION = "2.1.316";
  try {
    const first = await capabilities();
    assert.equal(first.agentFeatures.claude.settings.effort, "native");
    assert.equal(liveSettings("claude").effort, "native");
    process.env.DAISY_FIXTURE_VERSION_FAIL = "1";
    const failed = await capabilities();
    assert.equal(failed.claude.failed, true);
    assert.equal(failed.agentFeatures.claude.settings.effort, "native");
    assert.equal(liveSettings("claude").effort, "native");
    assert.equal(liveSettings("codex").model, "native");
    // A real downgrade is still taken.
    delete process.env.DAISY_FIXTURE_VERSION_FAIL;
    process.env.DAISY_FIXTURE_CLI_VERSION = "2.0.0";
    await capabilities();
    assert.equal(liveSettings("claude").effort, "restart");
  } finally {
    for (const k of [
      "DAISY_CLAUDE_BIN",
      "DAISY_CODEX_BIN",
      "DAISY_KIMI_BIN",
      "DAISY_FIXTURE_CLI_VERSION",
      "DAISY_FIXTURE_VERSION_FAIL",
    ])
      delete process.env[k];
    setLiveSettings(null);
  }
});
