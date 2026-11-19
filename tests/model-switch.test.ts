// the agent answered with another model than the session's — one
// trace step 「本轮换了模型」 for both engines (Claude Code 2.1.316
// `system/model_fallback` / `system/model_refusal_fallback`, Codex 0.157.1
// `model/rerouted`); a session-wide swap is what the session runs with.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  AGENT_CAPABILITIES,
  capabilitiesFor,
} from "../packages/contracts/src/agent-capabilities.ts";
import {
  claudeModelSwitch,
  codexModelSwitch,
  modelSwitchItem,
} from "../packages/daisy/src/harness/model-switch.ts";
import { claudeAgent } from "../packages/daisy/src/harness/claude.ts";
import { codexAgent } from "../packages/daisy/src/harness/codex.ts";
import {
  noHooks,
  type Runtime,
} from "../packages/daisy/src/harness/shared.ts";

const ENV = ["DAISY_CLAUDE_BIN", "DAISY_CODEX_BIN", "DAISY_CODEX_POLL_MS"];
const dirs: string[] = [];
afterEach(() => {
  for (const k of ENV) delete process.env[k];
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** The message a real run printed (claude 2.1.316, `--model claude-nonexistent-9 --fallback-model haiku`). */
const MEASURED = {
  type: "system",
  subtype: "model_fallback",
  trigger: "model_not_found",
  original_model: "claude-nonexistent-9",
  fallback_model: "claude-haiku-5-5",
  content:
    "Switched to Haiku 5.5 because claude-nonexistent-9 is not available",
  uuid: "u1",
  session_id: "s",
};

test("capabilities: both engines declare it natively from the measured versions; older / Kimi: none", () => {
  assert.equal(AGENT_CAPABILITIES.claude.modelSwitch?.support, "native");
  assert.equal(AGENT_CAPABILITIES.codex.modelSwitch?.support, "native");
  assert.equal(AGENT_CAPABILITIES.codex.modelSwitch?.via, "model/rerouted");
  assert.equal(AGENT_CAPABILITIES.kimi.modelSwitch?.support, "none");
  assert.equal(
    capabilitiesFor("claude", "2.1.316 (Claude Code)").modelSwitch?.support,
    "native",
  );
  assert.equal(
    capabilitiesFor("codex", "codex-cli 0.157.1").modelSwitch?.support,
    "native",
  );
  assert.equal(
    capabilitiesFor("claude", "2.1.300").modelSwitch?.support,
    "none",
  );
  assert.equal(
    capabilitiesFor("codex", "codex-cli 0.157.0").modelSwitch?.support,
    "none",
  );
  assert.equal(
    capabilitiesFor("codex", undefined).modelSwitch?.support,
    "none",
  );
});

test("parsing: the measured Claude fallback, a session-wide refusal retry, Codex's reroute; junk is not one", () => {
  const a = claudeModelSwitch(MEASURED)!;
  assert.deepEqual(
    { from: a.from, to: a.to, session: a.session, code: a.code },
    {
      from: "claude-nonexistent-9",
      to: "claude-haiku-5-5",
      session: false,
      code: "model_not_found",
    },
  );
  const item = modelSwitchItem(a);
  assert.equal(item.name, "本轮换了模型");
  assert.match(
    item.text!,
    /^原模型不存在或已下线：这一轮由 claude-haiku-5-5 回答（会话选的是 claude-nonexistent-9）\nSwitched to Haiku/,
  );
  const r = claudeModelSwitch({
    type: "system",
    subtype: "model_refusal_fallback",
    original_model: "o",
    fallback_model: "f",
    api_refusal_category: "cyber",
  })!;
  assert.equal(r.session, true); // scope absent = "session"
  assert.match(
    modelSwitchItem(r).text!,
    /原模型拒绝回答（类别 cyber）：这一轮及之后由 f 回答.*会话的模型已换成它/,
  );
  assert.equal(
    claudeModelSwitch({
      type: "system",
      subtype: "model_refusal_fallback",
      scope: "local",
      fallback_model: "f",
    })!.session,
    false,
  );
  const c = codexModelSwitch({
    fromModel: "gpt-6-astra",
    toModel: "gpt-6-safe",
    reason: "highRiskCyberActivity",
  })!;
  assert.match(
    modelSwitchItem(c).text!,
    /^检测到高风险的网络安全内容：这一轮由 gpt-6-safe 回答（会话选的是 gpt-6-astra）$/,
  );
  // A reason Daisy does not know yet: Codex's own code.
  assert.equal(
    codexModelSwitch({ toModel: "x", reason: "newReason" })!.reason,
    "newReason",
  );
  assert.equal(claudeModelSwitch({ type: "system", subtype: "init" }), null);
  assert.equal(
    claudeModelSwitch({ type: "system", subtype: "model_fallback" }),
    null,
  );
  assert.equal(codexModelSwitch({ fromModel: "a" }), null);
  // Control characters never reach the trace.
  assert.equal(
    claudeModelSwitch({ ...MEASURED, fallback_model: "a\u001b[31mb" })!.to,
    "a[31mb",
  );
});

const claudeJob = (jid: string, text: string) =>
  ({
    id: jid,
    text,
    attachments: [],
    lease: "l",
    session: {
      id: "s1",
      agent: "claude",
      nativeId: "claude-native",
      task: null,
    },
    profile: {
      id: "p",
      authMode: "apiKey",
      apiKey: "x",
      permissionMode: "manual",
    },
    workspace: { path: tmpdir() },
  }) as any;
const runtime = (j: any, emitted: [string, any][]): Runtime =>
  ({
    job: j,
    cwd: tmpdir(),
    prompt: j.text,
    files: [],
    signal: new AbortController().signal,
    emit: (type: string, data: any) => emitted.push([type, data]),
    flush: async () => {},
    approve: async () => ({ optionId: "allow" }),
    onInput: () => {},
  }) as any;

test("Claude adapter: a turn-scoped fallback is a trace step; a session-wide refusal retry also updates the runtime model", async () => {
  process.env.DAISY_CLAUDE_BIN = resolve("tests/fixtures/agent.cjs");
  const first = claudeJob("j1", "MODEL_FALLBACK_TEST");
  const a = claudeAgent(first, tmpdir(), noHooks, true);
  try {
    const e1: [string, any][] = [];
    await a.turn(runtime(first, e1));
    const step = e1.find(
      ([t, d]) => t === "item" && d.id === "j1:model-switch:mf-1",
    )?.[1];
    assert.ok(step, e1.map(([t, d]) => `${t}:${d?.id}`).join(","));
    assert.equal(step.category, "native");
    assert.equal(step.name, "本轮换了模型");
    assert.deepEqual(step.input, {
      from: "fixture-model",
      to: "claude-haiku-5-5",
      reason: "model_not_found",
      scope: "turn",
      engine: "claude",
    });
    // Turn-scoped: the runtime stays what init said.
    assert.deepEqual(
      e1.filter(([t, d]) => t === "native" && d.model).map(([, d]) => d.model),
      ["fixture-model"],
    );
    const j2 = claudeJob("j2", "MODEL_REFUSAL_TEST");
    const e2: [string, any][] = [];
    await a.turn(runtime(j2, e2));
    const refusalStep = e2.find(
      ([t, d]) => t === "item" && d.id === "j2:model-switch:mrf-1",
    )?.[1];
    assert.ok(refusalStep);
    // Follow-up 2026-11-09 (review L1): the refused model's partial answer
    // is kept but marked retracted (never deleted); the retry's is not.
    const last = (id: string) =>
      e2.filter(([t, d]) => t === "item" && d.id === id).at(-1)?.[1];
    const refused = last("j2:refused-msg:0");
    assert.equal(refused?.text, "Partial refused answer");
    assert.equal(refused?.retracted, true);
    assert.equal(refused?.status, "complete");
    assert.match(refusalStep.text, /1 段内容已撤回/);
    assert.equal(last("j2:mf:0")?.text, "OK");
    assert.equal(last("j2:mf:0")?.retracted, undefined);
    // Review L2: the refused model's tool call stays as it is (it ran).
    assert.equal(last("j2:refused-tool")?.retracted, undefined);
    // Review L2: an unparseable switch still retracts what it names.
    const j3 = claudeJob("j3", "MODEL_REFUSAL_TEST BARE");
    const e3: [string, any][] = [];
    await a.turn(runtime(j3, e3));
    assert.ok(!e3.some(([t, d]) => t === "item" && d.id?.includes("model-switch")));
    assert.equal(
      e3.filter(([t, d]) => t === "item" && d.id === "j3:refused-msg:0").at(-1)?.[1]
        ?.retracted,
      true,
    );
    const natives = e2
      .filter(([t, d]) => t === "native" && d.model)
      .map(([, d]) => d);
    assert.deepEqual(
      natives.map((d) => d.model),
      ["fixture-model", "fixture-fallback"],
    );
    // The rest of what init reported is kept (the store replaces runtime).
    assert.equal(natives[1].nativeId, natives[0].nativeId);
    assert.equal(natives[1].permissionMode, natives[0].permissionMode);
  } finally {
    a.stop();
    await a.stopped?.();
  }
});

function codexSetup() {
  const dir = mkdtempSync(join(tmpdir(), "codex-reroute-"));
  dirs.push(dir);
  process.env.DAISY_CODEX_BIN = resolve("tests/fixtures/agent.cjs");
  process.env.DAISY_CODEX_POLL_MS = "40";
  const job = (id: string) =>
    ({
      id,
      session: { id: "s1", agent: "codex", nativeId: null },
      profile: {
        id: "p1",
        label: "Codex",
        authMode: "subscription",
        permissionMode: "on-request",
      },
      attachments: [],
    }) as any;
  const items = new Map<string, any>();
  const agent = codexAgent(
    job("first"),
    process.cwd(),
    {
      ...noHooks,
      emit: (type, data: any) => {
        if (type === "item") items.set(data.id, data);
      },
    },
    true,
  );
  const rt = (j: any, prompt: string): Runtime => ({
    job: j,
    cwd: process.cwd(),
    prompt,
    files: [],
    signal: new AbortController().signal,
    emit: (type, data) => {
      if (type === "item") items.set(data.id, data);
    },
    flush: async () => {},
    approve: async () => ({ optionId: "accept" }),
  });
  return { agent, items, rt, job };
}

test("Codex adapter: model/rerouted is the same trace step (root and subagent thread)", async () => {
  const { agent, items, rt, job } = codexSetup();
  try {
    await agent.turn(rt(job("j1"), "MODEL_REROUTE"));
    const root = [...items.values()].find((i) => i.name === "本轮换了模型");
    assert.ok(root, [...items.keys()].join(","));
    assert.equal(root.category, "native");
    assert.deepEqual(root.input, {
      from: "gpt-6-astra",
      to: "gpt-6-safe",
      reason: "highRiskCyberActivity",
      scope: "turn",
      engine: "codex",
    });
    await agent.turn(rt(job("j2"), "MODEL_REROUTE_CHILD"));
    const child = [...items.values()].find((i) =>
      i.id.startsWith("j2:model-switch:child-a:"),
    );
    assert.ok(child, [...items.keys()].join(","));
    assert.equal(child.category, "subagent");
    assert.equal(child.threadId, "child-a");
  } finally {
    agent.stop();
    await agent.stopped?.();
  }
});
