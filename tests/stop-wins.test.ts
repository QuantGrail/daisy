// P5 gate (N-6 again): once 「停止」 was asked for a turn, the turn ends as
// interrupted — whatever the transport or the process reports afterwards.
// Windows' Job Object ends a tree at once, and the kill after the grace
// period can win too: the process's exit reached Daisy before the
// agent's own "interrupted", and the turn ended "Agent exited (SIGTERM)" /
// "Agent transport closed". Here the fake agent forces that order: it
// exits the moment it is asked to interrupt, before answering anything.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { codexAgent } from "../packages/daisy/src/harness/codex.ts";
import { claudeAgent } from "../packages/daisy/src/harness/claude.ts";
import { acpAgentFor } from "../packages/daisy/src/harness/acp.ts";
import { noHooks, type LiveAgent, type Runtime } from "../packages/daisy/src/harness/shared.ts";
import { fakeAcpCommand } from "./fixtures/acp-scenario.ts";

const ENV = ["DAISY_CODEX_BIN", "DAISY_CODEX_POLL_MS", "DAISY_CLAUDE_BIN", "DAISY_KIMI_BIN", "DAISY_FIXTURE_EXIT_ON_INTERRUPT"];
const dirs: string[] = [];
afterEach(() => {
  for (const k of ENV) delete process.env[k];
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const job = (agent: string, cwd: string) =>
  ({
    id: "j1",
    text: "x",
    lease: "l",
    session: { id: "s1", agent, nativeId: null },
    profile:
      agent === "claude"
        ? { id: "p1", label: agent, authMode: "apiKey", apiKey: "x", permissionMode: "manual" }
        : { id: "p1", label: agent, authMode: "subscription" },
    workspace: { path: cwd },
    attachments: [],
  }) as any;

/** Start a turn, stop it once its input was handed over; the turn's end. */
async function stopped(agent: LiveAgent, j: any, cwd: string, prompt: string) {
  const items: string[] = [];
  const stop = new AbortController();
  const rt: Runtime = {
    job: j,
    cwd,
    prompt,
    files: [],
    signal: stop.signal,
    emit: (_type: string, data: unknown) => items.push(JSON.stringify(data)),
    flush: async () => {},
    approve: async () => ({ optionId: "allow" }),
    onInput: () => {},
  } as any;
  const turn = agent.turn(rt);
  turn.catch(() => {});
  for (let i = 0; i < 400 && !items.some((x) => x.includes("输入已交给")); i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(items.some((x) => x.includes("输入已交给")), "the input was handed over");
  // The fake agent is asked to interrupt and exits at once: the exit (the
  // transport closing) comes first, the interrupt's bookkeeping second.
  stop.abort();
  const e = await turn.then(
    () => assert.fail("a stopped turn does not complete"),
    (x: Error) => x,
  );
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(agent.closed, true, "the process did exit first");
  return e.message;
}

function setup(agent: string) {
  const dir = mkdtempSync(join(tmpdir(), `stop-wins-${agent}-`));
  dirs.push(dir);
  process.env.DAISY_FIXTURE_EXIT_ON_INTERRUPT = "1";
  return dir;
}

test("停止 wins over the exit: Codex — the turn ends 中断, not the transport's or the exit's text", async () => {
  const dir = setup("codex");
  process.env.DAISY_CODEX_BIN = resolve("tests/fixtures/agent.cjs");
  process.env.DAISY_CODEX_POLL_MS = "40";
  const a = codexAgent(job("codex", dir), process.cwd(), noHooks, true);
  try {
    const end = await stopped(a, job("codex", dir), process.cwd(), "STOP_SCOPE");
    assert.match(end, /中断/);
    assert.doesNotMatch(end, /Agent (exited|transport)/);
  } finally {
    a.stop();
  }
});

test("停止 wins over the exit: Claude — the turn ends 本轮已停止", async () => {
  const dir = setup("claude");
  process.env.DAISY_CLAUDE_BIN = resolve("tests/fixtures/agent.cjs");
  const a = claudeAgent(job("claude", dir), dir, noHooks, true);
  try {
    const end = await stopped(a, job("claude", dir), dir, "HOLD_UNTIL_INTERRUPT");
    assert.match(end, /本轮已停止/);
    assert.doesNotMatch(end, /Agent (exited|transport)/);
  } finally {
    a.stop();
  }
});

test("停止 wins over the exit: an ACP harness — the turn ends 已取消", async () => {
  const dir = setup("kimi");
  process.env.DAISY_KIMI_BIN = fakeAcpCommand(dir, "kimi");
  const a = acpAgentFor("kimi")(job("kimi", dir), dir, noHooks, true);
  try {
    const end = await stopped(a, job("kimi", dir), dir, "SLOW please");
    assert.match(end, /已取消/);
    assert.doesNotMatch(end, /Agent (exited|transport)/);
  } finally {
    a.stop();
  }
});
