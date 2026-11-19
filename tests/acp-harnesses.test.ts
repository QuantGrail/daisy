/**
 * P4-10 (plan 5.5, ADR-130): the generic ACP adapter and its table.
 * Acceptance C-2 (every second-line harness passes the required
 * capabilities) and C-5 (a new ACP harness is one config entry, no code)
 * run against the fake ACP agent, one profile per entry
 * (tests/fixtures/acp-agent.cjs); the real CLIs are C-2 / C-5's device run.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ACP_AGENTS,
  ACP_HARNESSES,
  AGENT_IDS,
  BUILTIN_ACP_AGENTS,
  acpHarnessFromJson,
  agentBinEnv,
  agentCommand,
  managedLoginSupported,
  permissionModes,
  readOnlySupport,
} from "../packages/contracts/src/acp-harnesses.ts";
import {
  AGENT_CAPABILITIES,
  capabilitiesFor,
} from "../packages/contracts/src/agent-capabilities.ts";
import { AGENT_STOP } from "../packages/contracts/src/agent-stop.ts";
import { featuresFor } from "../packages/contracts/src/agent-features.ts";
import { AgentSchema } from "../packages/contracts/src/session.ts";
import { bypassMode } from "../packages/contracts/src/approvals.ts";
import { contextUsageCapability } from "../packages/contracts/src/context-usage.ts";
import { modelChoices } from "../packages/contracts/src/model-options.ts";
import { runAcp } from "../packages/daisy/src/harness/acp.ts";
import type { Runtime } from "../packages/daisy/src/harness/shared.ts";
import { createApp } from "../packages/daisy/src/app.ts";
import { DaisyClient } from "../packages/client/src/index.ts";
import {
  fakeAcpCommand,
  recorded,
  removeDir,
  runC2,
  scenarioDir,
} from "./fixtures/acp-scenario.ts";

const POSIX = { skip: process.platform === "win32" ? "sh wrappers" : false };

/** Each built-in entry, the fake profile that plays it, how it resumes. */
const ENTRIES: [string, "session/load" | "session/resume"][] = [
  ["kimi", "session/load"],
  ["opencode", "session/load"],
  ["antigravity", "session/load"],
  // DeepSeek Harness declares no loadSession: session/resume only.
  ["deepseek", "session/resume"],
];

test("the table: Kimi, OpenCode, Antigravity, DeepSeek Harness (experimental); every place that lists agents reads it", () => {
  assert.deepEqual(BUILTIN_ACP_AGENTS, ["kimi", "opencode", "antigravity", "deepseek"]);
  assert.deepEqual(AGENT_IDS, ["claude", "codex", ...ACP_AGENTS]);
  for (const a of AGENT_IDS) assert.equal(AgentSchema.parse(a), a);
  assert.throws(() => AgentSchema.parse("gemini"));
  const launch = Object.fromEntries(
    BUILTIN_ACP_AGENTS.map((a) => [a, [ACP_HARNESSES[a]!.launch.command, ...ACP_HARNESSES[a]!.launch.args].join(" ")]),
  );
  assert.deepEqual(launch, {
    kimi: "kimi acp",
    opencode: "opencode acp",
    antigravity: "agy acp",
    deepseek: "dsh acp",
  });
  assert.equal(ACP_HARNESSES.deepseek!.tier, "experimental");
  for (const a of ["kimi", "opencode", "antigravity"]) assert.equal(ACP_HARNESSES[a]!.tier, "second");
  for (const a of ACP_AGENTS) {
    // The capability shape (ADR-131), reported per agent; stop / settings / context all present.
    const c = AGENT_CAPABILITIES[a]!;
    assert.equal(c.version, 1);
    assert.equal(c.agent, a);
    assert.ok(c.input && c.settings && c.askOnly && c.rewind && c.title);
    assert.equal(capabilitiesFor(a, "1.0.0").agent, a);
    assert.equal(AGENT_STOP[a]!.version, 1);
    assert.equal(contextUsageCapability().agents[a as "kimi"]!.configurable, false);
  }
  // The command and its override (DAISY_KIMI_BIN as before).
  assert.equal(agentBinEnv("kimi"), "DAISY_KIMI_BIN");
  assert.equal(agentCommand("antigravity", {}), "agy");
  assert.equal(agentCommand("antigravity", { DAISY_ANTIGRAVITY_BIN: "/x/agy" }), "/x/agy");
  assert.equal(agentCommand("claude", {}), "claude");
});

test("Kimi keeps what it declared before P4-10 (regression)", () => {
  const k = AGENT_CAPABILITIES.kimi!;
  assert.deepEqual(k.input.steer, { support: "fallback" });
  assert.deepEqual(k.settings, { model: "restart", effort: "restart", permissionMode: "restart" });
  assert.deepEqual(k.askOnly, { sideQuestion: "none", fork: "none" });
  assert.deepEqual(k.rewind, { history: "native", files: "none" });
  assert.deepEqual(k.title, { generate: "none", sync: "none" });
  assert.deepEqual(AGENT_STOP.kimi, {
    version: 1,
    subagents: "none",
    commands: "native",
    survives: ["backgroundTasks"],
    killAfterMs: 5000,
  });
  assert.deepEqual(permissionModes("kimi").values, ["default", "plan", "auto", "yolo"]);
  assert.equal(bypassMode({ agent: "kimi", permissionMode: "yolo" }), true);
  assert.deepEqual(
    modelChoices("kimi").efforts.map((e) => e.value),
    ["", "low", "high", "max"],
  );
});

test("weak read-only (Kimi, OpenCode plan) is said so; no read-only over ACP (Antigravity, DeepSeek) — no 「问」", () => {
  assert.equal(readOnlySupport("claude"), "strong");
  assert.equal(readOnlySupport("codex"), "strong");
  assert.equal(readOnlySupport("kimi"), "weak");
  assert.equal(ACP_HARNESSES.kimi!.modes.readOnly, "plan");
  assert.equal(readOnlySupport("opencode"), "weak");
  assert.equal(ACP_HARNESSES.opencode!.modes.readOnly, "plan");
  assert.equal(readOnlySupport("antigravity"), "none");
  assert.equal(readOnlySupport("deepseek"), "none");
  // No modes over ACP: nothing to pick, nothing that bypasses.
  assert.deepEqual(permissionModes("antigravity").values, []);
  assert.equal(bypassMode({ agent: "opencode", permissionMode: "build" }), false);
});

test("refused: a broken extra entry stops the start (reserved id, bad id, no command)", () => {
  assert.throws(() => acpHarnessFromJson({ id: "kimi", launch: { command: "x" } }), /已被占用/);
  assert.throws(() => acpHarnessFromJson({ id: "claude", launch: { command: "x" } }), /已被占用/);
  assert.throws(() => acpHarnessFromJson({ id: "runner", launch: { command: "x" } }), /已被占用/);
  assert.throws(() => acpHarnessFromJson({ id: "Bad Id", launch: { command: "x" } }), /id 无效/);
  assert.throws(() => acpHarnessFromJson({ id: "newone" }), /launch/);
  assert.throws(() => acpHarnessFromJson({ id: "newone", launch: { command: "x", args: [1] } }), /launch/);
  // A JSON entry cannot claim native optional capabilities (5.5: never simulated).
  const h = acpHarnessFromJson({
    id: "newone",
    launch: { command: "new-agent", args: ["acp"] },
    capabilities: { input: { steer: { support: "native" } } },
  });
  assert.equal(h.capabilities.input.steer.support, "fallback");
  assert.equal(h.tier, "experimental");
  assert.equal(h.login, undefined);
  assert.deepEqual(h.resume, ["load", "resume"]);
});

test("refused: identities of their own, logins and modes an ACP harness does not have", async () => {
  const dir = scenarioDir("refuse");
  const ctx = await createApp({ pinGate: false, workspaceHome: dir, workspaceRoots: [dir], dataDir: dir });
  try {
    const url = await ctx.app.listen({ host: "127.0.0.1", port: 0 });
    const c = new DaisyClient(url, ctx.issueToken());
    const cat = await c.catalog();
    const nodeId = cat.profiles[0]!.nodeId;
    // No relocatable CLI directory / login entry: no managed identity.
    for (const agent of ["opencode", "antigravity", "deepseek"]) {
      assert.equal(managedLoginSupported(agent), false);
      await assert.rejects(
        c.request("/identities", "POST", { agent, nodeId, label: "x" }),
        (e: any) => e.status === 400 && /不支持独立登录/.test(e.message),
      );
    }
    // Kimi has both, as before.
    assert.equal(managedLoginSupported("kimi"), true);
    const kimi = await c.request<any>("/identities", "POST", { agent: "kimi", nodeId, label: "k" });
    assert.equal(kimi.configDir, `managed:${kimi.id}`);
    // A mode the harness does not have (Antigravity: none over ACP).
    const agy = cat.profiles.find((p) => p.agent === "antigravity")!;
    await assert.rejects(
      c.request(`/profiles/${agy.id}`, "PATCH", { model: "", permissionMode: "plan" }),
      (e: any) => e.status === 400,
    );
    const oc = cat.profiles.find((p) => p.agent === "opencode")!;
    await c.request(`/profiles/${oc.id}`, "PATCH", { model: "", permissionMode: "plan" });
    // Not an agent at all.
    await assert.rejects(
      c.request("/identities", "POST", { agent: "gemini", nodeId, label: "x" }),
      (e: any) => e.status === 400,
    );
  } finally {
    await ctx.app.close();
    removeDir(dir);
  }
});

/** One turn of `agent` through the adapter alone, with settings. */
async function adapterTurn(
  agent: string,
  dir: string,
  profile: Record<string, string>,
  prompt = "NOTOOL hi",
) {
  const env = `DAISY_${agent.toUpperCase()}_BIN`;
  process.env[env] = fakeAcpCommand(dir, agent);
  const events: any[] = [];
  const rt: Runtime = {
    job: {
      id: "job1",
      text: prompt,
      session: { id: "s1", agent, nativeId: null },
      profile: { authMode: "subscription", label: "x", ...profile },
      attachments: [],
    } as any,
    cwd: dir,
    prompt,
    files: [],
    signal: new AbortController().signal,
    emit: (type, data) => events.push({ type, data }),
    flush: async () => {},
    approve: async () => ({ optionId: "allow" }),
  };
  try {
    await runAcp(rt);
    return { events, error: null as any };
  } catch (e) {
    return { events, error: e as Error };
  } finally {
    delete process.env[env];
  }
}

test("model / effort / mode go by the session's config options (session/set_config_option by category), modes by session/set_mode", POSIX, async () => {
  const want: Record<string, { model: string; effort: string; mode?: string; effortId: string }> = {
    kimi: { model: "kimi-k3-turbo", effort: "max", mode: "plan", effortId: "thinking" },
    opencode: { model: "openai/gpt", effort: "high", mode: "plan", effortId: "effort" },
    antigravity: { model: "gemini-flash", effort: "max", effortId: "thinking_level" },
    deepseek: { model: "deepseek-v4-flash", effort: "low", effortId: "reasoning_effort" },
  };
  for (const [agent, w] of Object.entries(want)) {
    const dir = scenarioDir(`cfg-${agent}`);
    try {
      const r = await adapterTurn(agent, dir, {
        model: w.model,
        reasoningEffort: w.effort,
        ...(w.mode ? { permissionMode: w.mode } : {}),
      });
      assert.equal(r.error, null, `${agent}: ${r.error?.message}`);
      const calls = recorded(dir);
      const set = calls.filter((x) => x.method === "session/set_config_option").map((x) => [x.params.configId, x.params.value]);
      assert.deepEqual(set, [["model", w.model], [w.effortId, w.effort]], agent);
      assert.ok(!calls.some((x) => x.method === "session/set_model"), `${agent}: no removed set_model`);
      assert.deepEqual(
        calls.filter((x) => x.method === "session/set_mode").map((x) => x.params.modeId),
        w.mode ? [w.mode] : [],
      );
      assert.ok(r.events.some((e) => e.type === "item" && /markers: none/.test(e.data.text || "")));
    } finally {
      removeDir(dir);
    }
  }
  // A mode where ACP has none: said, not simulated.
  const dir = scenarioDir("cfg-nomode");
  try {
    const r = await adapterTurn("deepseek", dir, { permissionMode: "plan" });
    assert.match(r.error?.message || "", /DeepSeek Harness 经 ACP 没有权限模式/);
  } finally {
    removeDir(dir);
  }
});

test("§5.5 declared per entry (P4-11's map): fork / compact / usage / modes as each harness has them; /compact only when the session lists it", POSIX, async () => {
  const f = (a: string) => featuresFor(null, a);
  for (const a of ACP_AGENTS) {
    for (const k of ["session", "stream", "cancel", "approvals"] as const)
      assert.equal(f(a)[k], "native", `${a} ${k}`);
    for (const k of ["steer", "withdraw", "rewindFiles", "askOnly", "quota"] as const)
      assert.equal(f(a)[k], "none", `${a} ${k}`);
  }
  assert.deepEqual(
    Object.fromEntries(ACP_AGENTS.map((a) => [a, [f(a).fork, f(a).compact, f(a).usage, f(a).permissionMode, f(a).readOnly, f(a).terminal]])),
    {
      kimi: ["native", "native", "native", "fallback", "native", "native"],
      opencode: ["native", "none", "native", "fallback", "native", "none"],
      antigravity: ["none", "none", "none", "none", "none", "none"],
      deepseek: ["none", "none", "none", "none", "none", "none"],
    },
  );
  assert.equal(AGENT_CAPABILITIES.kimi!.readOnly?.opts?.strength, "weak");
  assert.equal(AGENT_CAPABILITIES.opencode!.readOnly?.opts?.mode, "plan");
  // /compact goes to the agent only when its session advertises it.
  const dir = scenarioDir("compact");
  try {
    const ok = await adapterTurn("kimi", dir, {}, "/compact");
    assert.equal(ok.error, null, ok.error?.message);
    assert.ok(recorded(dir).some((x) => x.method === "session/prompt" && x.params.prompt[0].text === "/compact"));
    const no = await adapterTurn("opencode", dir, {}, "/compact");
    assert.match(no.error?.message || "", /OpenCode 的这个会话没有 \/compact 命令/);
  } finally {
    removeDir(dir);
  }
});

for (const [agent, resume] of ENTRIES)
  test(`C-2 ${ACP_HARNESSES[agent]!.name}: open, send and stream, approve / reject, cancel, resume (${resume})`, { ...POSIX, timeout: 120_000 }, async () => {
    const dir = scenarioDir(`c2-${agent}`);
    const env = `DAISY_${agent.toUpperCase()}_BIN`;
    process.env[env] = fakeAcpCommand(dir, agent);
    try {
      const r = await runC2(agent, dir, resume);
      assert.deepEqual(r.steps, ["open", "stream", "approve", "reject", "cancel", "resume"]);
      assert.equal(r.resumedBy, resume);
    } finally {
      delete process.env[env];
      removeDir(dir);
    }
  });

test("C-5: a new ACP harness is one entry in $DAISY_ACP_HARNESSES — no code — and passes the required capabilities", { ...POSIX, timeout: 120_000 }, async () => {
  const dir = scenarioDir("c5");
  try {
    const file = join(dir, "acp-harnesses.json");
    writeFileSync(
      file,
      JSON.stringify([
        {
          id: "fakeacp",
          name: "Fake ACP",
          launch: { command: fakeAcpCommand(dir, "minimal"), args: ["acp"] },
        },
      ]),
    );
    const env: Record<string, string | undefined> = {
      ...process.env,
      DAISY_ACP_HARNESSES: file,
    };
    for (const k of Object.keys(env)) if (/^DAISY_.*_BIN$/.test(k)) delete env[k];
    const r = await promisify(execFile)(
      process.execPath,
      ["--import", "tsx", "tests/fixtures/acp-c5-child.ts", dir, "fakeacp"],
      { env: env as NodeJS.ProcessEnv, timeout: 110_000, maxBuffer: 8 * 1024 * 1024 },
    ).catch((e) => e);
    const line = String(r.stdout || "").trim().split("\n").pop() || "{}";
    const out = JSON.parse(line);
    assert.equal(out.ok, true, out.error || r.stderr);
    assert.deepEqual(out.result.steps, ["open", "stream", "approve", "reject", "cancel", "resume"]);
    assert.equal(out.result.resumedBy, "session/load");
    // Detected by its own version probe, reported like any other agent.
    assert.deepEqual(out.detected, { installed: true, version: "minimal 1.2.3 (fake acp)" });
    assert.equal(out.reported, "fakeacp");
    assert.equal(out.declared.input.steer.support, "fallback");
  } finally {
    removeDir(dir);
  }
});
