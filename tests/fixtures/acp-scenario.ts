/**
 * P4-10: acceptance C-2 / C-5 against the fake ACP agent (acp-agent.cjs),
 * through the whole of Daisy — the local API, the in-process Runner, the
 * generic ACP adapter. The required capabilities of plan 5.5, one by one:
 * open a session; send and stream (thought, tool call, answer arrive while
 * the turn runs); tool approval (allow and reject become cards); cancel
 * (the turn stops, the process stays); resume (a new process continues the
 * same native session — `session/load` or `session/resume`, whichever the
 * agent declares — and remembers).
 */
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createApp } from "../../packages/daisy/src/app.ts";
import {
  runNode,
  type NodeConfig,
} from "../../packages/daisy/src/turns/worker.ts";
import { DaisyClient } from "../../packages/client/src/index.ts";
import type { Snapshot } from "../../packages/contracts/src/index.ts";
import { runnerConfig } from "./runner-calls.ts";

export const ACP_FIXTURE = resolve("tests/fixtures/acp-agent.cjs");
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
export async function until<T>(
  read: () => Promise<T>,
  accept: (x: T) => boolean,
  what = "state",
) {
  let last: T | undefined;
  for (let i = 0; i < 200; i++) {
    last = await read();
    if (accept(last)) return last;
    await delay(100);
  }
  throw Error(`${what} timed out: ${JSON.stringify(last)?.slice(0, 2000)}`);
}
/**
 * A command that runs the fake as `profile` (what an entry's `launch.command`
 * or `DAISY_<ID>_BIN` points at), recording into `dir`.
 */
export function fakeAcpCommand(dir: string, profile: string) {
  const state = join(dir, "acp-state");
  mkdirSync(state, { recursive: true });
  // A Node script (P5-05: Windows has no #!/bin/sh; Daisy runs a Node
  // script named by path under node there, by its shebang elsewhere).
  const file = join(dir, `fake-${profile}.cjs`);
  writeFileSync(
    file,
    `#!/usr/bin/env node\n${Object.entries({
      FAKE_ACP_PROFILE: profile,
      FAKE_ACP_STATE: state,
      FAKE_ACP_RECORD: join(dir, "acp-record.jsonl"),
    })
      .map(([k, v]) => `process.env[${JSON.stringify(k)}] = ${JSON.stringify(v)};`)
      .join("\n")}\nrequire(${JSON.stringify(ACP_FIXTURE)});\n`,
    { mode: 0o755 },
  );
  return file;
}
export const recorded = (dir: string) => {
  const f = join(dir, "acp-record.jsonl");
  return existsSync(f)
    ? readFileSync(f, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
};
const idle = (x: Snapshot) =>
  !["queued", "running", "waiting"].includes(x.session.status);
const texts = (x: Snapshot, kind: string) =>
  x.items.filter((i) => i.kind === kind).map((i) => String(i.text || ""));

export interface C2Result {
  agent: string;
  nativeId: string;
  resumedBy: string;
  steps: string[];
}
/**
 * Runs C-2's required capabilities for `agent` on a fresh Daisy in `dir`.
 * `expectResume`: the method the agent's declaration should lead to.
 */
export async function runC2(
  agent: string,
  dir: string,
  expectResume: "session/load" | "session/resume",
): Promise<C2Result> {
  const steps: string[] = [];
  const ctx = await createApp({
    pinGate: false,
    workspaceHome: dir,
    workspaceRoots: [dir],
    dataDir: dir,
  });
  const url = await ctx.app.listen({ host: "127.0.0.1", port: 0 });
  const c = new DaisyClient(url, ctx.issueToken());
  const config: NodeConfig = {
    ...runnerConfig(ctx, join(dir, "runner.json")),
    identityRoot: join(dir, "runner-state-root"),
  };
  let controller = new AbortController();
  let worker = runNode(config, controller.signal);
  const restartRunner = async () => {
    controller.abort();
    await worker.catch(() => {});
    controller = new AbortController();
    worker = runNode(config, controller.signal);
  };
  try {
    const cat = await c.catalog();
    const profile = cat.profiles.find((p) => p.agent === agent);
    assert.ok(profile, `a host-login identity of ${agent} (bootstrap)`);
    // 开会话
    const s = await c.create({
      agent: agent as any,
      title: `c2-${agent}`,
      profileId: profile!.id,
      workspaceId: cat.workspaces[0]!.id,
    });
    assert.equal(s.agent, agent);
    steps.push("open");

    // 发消息并流式返回 + 工具授权 (allow): thought and the tool call are
    // there while the turn still waits for the card.
    await c.send(s.id, "remember [[alpha]]");
    const asking = await until(
      () => c.snapshot(s.id),
      (x) => x.approvals.some((a) => a.status === "pending"),
      "approval card",
    );
    assert.ok(texts(asking, "thinking").some((t) => /Thinking/.test(t)));
    assert.ok(
      asking.items.some(
        (i) => i.kind === "tool" && i.status === "running" && /Read notes/.test(String(i.name)),
      ),
      "the tool call streamed before the turn ended",
    );
    const card = asking.approvals.find((a) => a.status === "pending")!;
    assert.deepEqual(
      card.options.map((o) => o.label),
      ["Allow", "Reject"],
    );
    await c.approve(s.id, card.id, "allow");
    let done = await until(
      () => c.snapshot(s.id),
      (x) => idle(x) && texts(x, "assistant").some((t) => /markers:/.test(t)),
      "first answer",
    );
    assert.ok(texts(done, "assistant").some((t) => t.includes("markers: alpha")));
    assert.ok(
      done.items.some((i) => i.kind === "tool" && i.status === "complete"),
    );
    steps.push("stream", "approve");

    // 工具授权 (reject): the agent is told, the turn still answers.
    await c.send(s.id, "again [[beta]]");
    const asking2 = await until(
      () => c.snapshot(s.id),
      (x) => x.approvals.some((a) => a.status === "pending"),
      "second approval card",
    );
    const card2 = asking2.approvals.find((a) => a.status === "pending")!;
    await c.approve(s.id, card2.id, "reject");
    done = await until(
      () => c.snapshot(s.id),
      (x) =>
        idle(x) &&
        texts(x, "assistant").some((t) => t.includes("markers: alpha,beta")),
      "answer after reject",
    );
    assert.ok(texts(done, "assistant").some((t) => /tool denied/.test(t)));
    assert.ok(done.items.some((i) => i.kind === "tool" && i.status === "error"));
    steps.push("reject");

    // 取消: the running turn stops (session/cancel); the process stays.
    const before = recorded(dir).filter((r) => r.method === "initialize").length;
    await c.send(s.id, "SLOW [[gamma]]");
    await until(
      () => c.snapshot(s.id),
      (x) => texts(x, "assistant").some((t) => /Working slowly/.test(t)),
      "slow turn streaming",
    );
    await c.cancel(s.id);
    const stopped = await until(
      () => c.snapshot(s.id),
      (x) => x.session.status === "interrupted",
      "interrupted",
    );
    assert.ok(stopped.session.live?.online, "the process is kept after 停止");
    assert.ok(recorded(dir).some((r) => r.method === "session/cancel"));
    await c.send(s.id, "NOTOOL still here [[after]]");
    await until(
      () => c.snapshot(s.id),
      (x) => idle(x) && texts(x, "assistant").some((t) => /,gamma,after/.test(t)),
      "turn after cancel",
    );
    assert.equal(
      recorded(dir).filter((r) => r.method === "initialize").length,
      before,
      "the turn after 停止 ran in the same process",
    );
    steps.push("cancel");

    // 恢复: a new Runner, a new process, the same native session.
    const nativeId = recorded(dir).find((r) => r.method === "session/prompt")!
      .params.sessionId as string;
    await restartRunner();
    await until(
      () => c.snapshot(s.id),
      (x) => x.session.live?.online === false,
      "offline after the restart",
    );
    const firstPid = recorded(dir).find((r) => r.method === "initialize")!.pid;
    await c.send(s.id, "NOTOOL back [[delta]]");
    done = await until(
      () => c.snapshot(s.id),
      (x) =>
        idle(x) &&
        texts(x, "assistant").some((t) =>
          t.includes("markers: alpha,beta,gamma,after,delta"),
        ),
      "resumed answer",
    );
    const later = recorded(dir).filter((r) => r.pid !== firstPid);
    const reopened = later.find((r) =>
      ["session/load", "session/resume", "session/new"].includes(r.method),
    );
    assert.equal(reopened?.method, expectResume, "resumed as declared");
    assert.equal(reopened?.params.sessionId, nativeId);
    steps.push("resume");
    return { agent, nativeId, resumedBy: reopened!.method, steps };
  } finally {
    controller.abort();
    await worker.catch(() => {});
    await ctx.app.close();
  }
}
/** A fresh directory for one run (removed by the caller). */
export const scenarioDir = (tag: string) =>
  mkdtempSync(join(tmpdir(), `daisy-acp-${tag}-`));
export const removeDir = (dir: string) =>
  rmSync(dir, { recursive: true, force: true });
