import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createApp } from "../../packages/daisy/src/app.ts";
import { runNode, type NodeConfig } from "../../packages/daisy/src/turns/worker.ts";
import { DaisyClient } from "../../packages/client/src/index.ts";
import type { Snapshot } from "../../packages/contracts/src/index.ts";
import { runnerConfig } from "./runner-calls.ts";
import { OWNER_ID } from "../../packages/daisy/src/access/owner.ts";
/**
 * Scheduler tests: a control plane and a Runner on the fake CLIs
 * (tests/fixtures/agent.cjs), with helpers for Daisy's tools.
 */
export const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
export async function until<T>(
  read: () => Promise<T> | T,
  accept: (x: T) => boolean,
  tries = 200,
) {
  let last: T | undefined;
  for (let i = 0; i < tries; i++) {
    last = await read();
    if (accept(last)) return last;
    await delay(100);
  }
  throw Error(`State timed out: ${JSON.stringify(last)?.slice(0, 600)}`);
}
export const idle = (x: Snapshot) =>
  !["queued", "running", "waiting"].includes(x.session.status);
export const tool = (name: string, args: unknown) =>
  `DAISY_TOOL ${JSON.stringify({ tool: name, arguments: args })}`;
export async function setup(
  extra: Partial<NodeConfig> = {},
  /** control-plane options (scheduler limits). */
  app: Partial<Parameters<typeof createApp>[0]> = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "daisy-sched-"));
  const ctx = await createApp({ pinGate: false,
    workspaceHome: dir,
    workspaceRoots: [dir],
    dataDir: dir,
    ...app,
  });
  const url = await ctx.app.listen({ host: "127.0.0.1", port: 0 });
  const uid = OWNER_ID;
  const c = new DaisyClient(url, ctx.issueToken());
  const config: NodeConfig = {
    ...runnerConfig(ctx, join(dir, "runner.json")),
    ...extra,
  };
  const record = join(dir, "record.jsonl"),
    thread = join(dir, "thread.jsonl"),
    spawns = join(dir, "spawns.jsonl");
  for (const a of ["CLAUDE", "CODEX", "KIMI"])
    process.env[`DAISY_${a}_BIN`] = resolve("tests/fixtures/agent.cjs");
  process.env.DAISY_FIXTURE_RECORD = record;
  process.env.DAISY_FIXTURE_RECORD_TOOLS = record;
  process.env.DAISY_FIXTURE_RECORD_THREAD = thread;
  process.env.DAISY_FIXTURE_ENV_FILE = spawns;
  config.identityRoot ??= join(dir, "runner-state-root");
  let controller = new AbortController();
  let worker = runNode(config, controller.signal);
  const cat = await c.catalog();
  const profile = (agent: string) =>
    cat.profiles.find((p) => p.agent === agent)!;
  const create = (agent: "claude" | "codex", title = "定时") =>
    c.create({
      agent,
      title,
      profileId: profile(agent).id,
      workspaceId: cat.workspaces[0].id,
    });
  const lines = (file: string) =>
    existsSync(file)
      ? readFileSync(file, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l))
      : [];
  /** Answer every pending approval until the session is idle. */
  const settle = async (sid: string) => {
    for (let i = 0; i < 300; i++) {
      const x = await c.snapshot(sid);
      const a = x.approvals.find((a) => a.status === "pending");
      if (a) await c.approve(sid, a.id, a.options[0].id);
      else if (idle(x)) return x;
      await delay(100);
    }
    throw Error("did not settle");
  };
  const turn = async (sid: string, text: string) => {
    await c.send(sid, text);
    await until(
      () => c.snapshot(sid),
      (x) => x.session.status !== "idle" || x.items.length > 1,
    );
    return settle(sid);
  };
  const toolResults = () =>
    lines(record).filter((x) => x.via === "daisy-tool");
  const schedules = async (sid: string) =>
    (await c.request(`/sessions/${sid}/schedules`)).schedules as any[];
  /** Make a timer due now (instead of waiting for it). */
  const due = (scid: string) =>
    ctx.store.run(
      "UPDATE agent_schedules SET next_at=? WHERE id=?",
      Date.now() - 1,
      scid,
    );
  const restartRunner = async () => {
    controller.abort();
    await worker.catch(() => {});
    controller = new AbortController();
    worker = runNode(config, controller.signal);
  };
  const close = async () => {
    controller.abort();
    await worker.catch(() => {});
    await ctx.app.close();
    for (const k of [
      "DAISY_CLAUDE_BIN",
      "DAISY_CODEX_BIN",
      "DAISY_KIMI_BIN",
      "DAISY_FIXTURE_RECORD",
      "DAISY_FIXTURE_RECORD_TOOLS",
      "DAISY_FIXTURE_RECORD_THREAD",
      "DAISY_FIXTURE_ENV_FILE",
    ])
      delete process.env[k];
    rmSync(dir, { recursive: true, force: true });
  };
  return {
    c,
    ctx,
    uid,
    url,
    cat,
    profile,
    create,
    settle,
    turn,
    lines,
    record,
    thread,
    spawns,
    toolResults,
    schedules,
    due,
    restartRunner,
    /** The running Runner's result (resolves when it exits by itself or is stopped). */
    worker: () => worker,
    close,
    config,
    dir,
  };
}
