/**
 * P4-08 tests: a whole Daisy for the A2A client — createApp (its own data
 * directory, a PIN stand-in) listening on 127.0.0.1 (a temporary port),
 * with its in-process Runner on the fake CLIs (tests/fixtures/agent.cjs),
 * so an AI's turn really calls the harness tools. Two of these in one
 * process call each other.
 *
 * The A2A client's outbound policy normally refuses loopback (ADR-127 §4);
 * these Daisies set the tests-only `a2aClient.policy.allowLoopback`
 * (`loopback: false` gives the production policy) and poll fast.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createApp } from "../../packages/daisy/src/app.ts";
import { runNode } from "../../packages/daisy/src/turns/worker.ts";
import { DaisyClient } from "../../packages/client/src/index.ts";
import { PIN_GRANT_HEADER } from "../../packages/daisy/src/access/pin-seam.ts";
import { api } from "../../packages/contracts/src/api/index.ts";
import type { A2AExecutor } from "../../packages/daisy/src/a2a/executors.ts";
import type { Snapshot } from "../../packages/contracts/src/index.ts";
import { pinDouble } from "./pin-double.ts";
import { runnerConfig } from "./runner-calls.ts";

export const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
export async function until<T>(read: () => Promise<T> | T, accept: (x: T) => boolean, tries = 300, every = 100) {
  let last: T | undefined;
  for (let i = 0; i < tries; i++) {
    last = await read();
    if (accept(last)) return last;
    await delay(every);
  }
  throw Error(`State timed out: ${JSON.stringify(last)?.slice(0, 800)}`);
}
export const tool = (name: string, args: unknown) => `DAISY_TOOL ${JSON.stringify({ tool: name, arguments: args })}`;

/** The fake CLIs record every Daisy tool result here (one file for the whole test file). */
export function fixtureCli(dir: string) {
  const record = join(dir, "daisy-tools.jsonl");
  for (const a of ["CLAUDE", "CODEX", "KIMI"]) process.env[`DAISY_${a}_BIN`] = resolve("tests/fixtures/agent.cjs");
  process.env.DAISY_FIXTURE_RECORD_TOOLS = record;
  const results = (): { tool: string; result: { text: string; isError: boolean } }[] =>
    existsSync(record)
      ? readFileSync(record, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l))
          .filter((x) => x.via === "daisy-tool")
      : [];
  return {
    results,
    close() {
      for (const a of ["CLAUDE", "CODEX", "KIMI"]) delete process.env[`DAISY_${a}_BIN`];
      delete process.env.DAISY_FIXTURE_RECORD_TOOLS;
    },
  };
}

export async function a2aNode(
  name: string,
  o: {
    loopback?: boolean;
    /** P5-02: through a test relay (tests/fixtures/relay-net.ts): its createApp option and the client's resolver. */
    relay?: { options: import("../../packages/daisy/src/app/context.ts").AppOptions["relay"]; policy: import("../../packages/daisy/src/a2a/client/index.ts").OutboundPolicy };
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), `daisy-a2a-${name}-`));
  const pin = pinDouble();
  const ctx = await createApp({
    pinGate: false,
    dataDir: dir,
    workspaceHome: dir,
    workspaceRoots: [dir],
    sharedHost: () => false,
    peerIsOwner: () => true,
    pin,
    ...(o.relay ? { relay: o.relay.options } : {}),
    a2aClient: {
      ...(o.relay ? { policy: o.relay.policy } : o.loopback === false ? {} : { policy: { allowLoopback: true } }),
      limits: { pollFirstMs: 100, pollMaxMs: 300, pollAuthMaxMs: 300 },
    },
  });
  const url = await ctx.app.listen({ host: "127.0.0.1", port: 0 });
  const c = new DaisyClient(url, ctx.issueToken());
  const cli = readFileSync(join(dir, "keys", "cli-credential"), "utf8").trim();
  const withPin = () => ({ authorization: `Bearer ${cli}`, [PIN_GRANT_HEADER]: pin.grant("246810", "cli").grant });
  const config = { ...runnerConfig(ctx, join(dir, "runner.json")), identityRoot: join(dir, "runner-state-root") };
  const controller = new AbortController();
  const worker = runNode(config, controller.signal);
  const cat = await c.catalog();
  /**
   * The fake CLI's ordinary turn asks to run a Bash command: the owner
   * allows it, for every session made here (wakes and relayed turns too).
   */
  const sessions = new Set<string>();
  let approving = false;
  const approver = setInterval(async () => {
    if (approving) return;
    approving = true;
    try {
      for (const sid of sessions) {
        const x = await c.snapshot(sid).catch(() => null);
        for (const a of x?.approvals ?? []) if (a.status === "pending") await c.approve(sid, a.id, a.options[0]!.id).catch(() => {});
      }
    } finally {
      approving = false;
    }
  }, 100);
  /** A Claude session (the fake CLI). */
  const session = async (title: string) => {
    const s = await c.create({
      agent: "claude",
      title,
      profileId: cat.profiles.find((p) => p.agent === "claude")!.id,
      workspaceId: cat.workspaces[0]!.id,
    });
    sessions.add(s.id);
    return s;
  };
  /** This Daisy's identity card with its listening address as the direct address. */
  const card = async () => {
    const r = await ctx.app.inject({
      method: "GET",
      url: `${api.contacts.contactExport.path}?name=${encodeURIComponent(name)}&direct=${encodeURIComponent(url)}`,
      headers: withPin(),
    });
    assert.equal(r.statusCode, 200, r.body);
    return r.json() as { id: string; urn: string; text: string };
  };
  /** P5-02: this Daisy's card as exported by default (the relay address while a relay is on). */
  const exportedCard = async () => {
    const r = await ctx.app.inject({ method: "GET", url: `${api.contacts.contactExport.path}?name=${encodeURIComponent(name)}`, headers: withPin() });
    assert.equal(r.statusCode, 200, r.body);
    return r.json() as { id: string; urn: string; text: string; addrs: { kind: string; url: string }[] };
  };
  const importCard = async (text: string, whitelist = true) => {
    const r = await ctx.app.inject({
      method: "POST",
      url: api.contacts.contactImport.path,
      headers: withPin(),
      payload: { card: text, whitelist },
    });
    assert.equal(r.statusCode, 200, r.body);
    return r.json();
  };
  /**
   * Make sessions public agents (P4-06 is not built yet: a fixture resolver,
   * the directory, and the executor the test gives).
   */
  const publish = (ids: () => string[], executor: A2AExecutor) => {
    ctx.access.invoke.agents.add((id) => {
      if (!ids().includes(id)) return null;
      const s = ctx.store.session(id);
      return s ? { id, kind: "public", name: s.title || id, sessionId: id } : null;
    });
    ctx.a2a.directory.add(() => ids());
    ctx.a2a.executors.add((agent) => (ids().includes(agent.id) ? executor : null));
  };
  /** Turns of `sid` not finished yet (waiting behind another, queued, running). */
  const open = (sid: string) =>
    ctx.store.one("SELECT COUNT(*) n FROM jobs WHERE session_id=? AND status IN ('pending','queued','running')", sid).n as number;
  const idle = (x: Snapshot) => !["queued", "running", "waiting"].includes(x.session.status);
  /** Send `text` to session `sid` and wait until it is idle again. */
  const turn = async (sid: string, text: string) => {
    const before = ctx.store.one("SELECT COUNT(*) n FROM jobs WHERE session_id=?", sid).n as number;
    // A call's answer wakes the AI on its own (ADR-127 §6: returnImmediately,
    // polling, one wake when it settles), so a wake turn can start at any
    // moment — also between a check here and the send. The owner's message
    // queues behind it (the page's 排队发送) instead of being refused 409.
    await c.send(sid, text, [], undefined, "queue");
    await until(
      () => open(sid),
      (n) => n === 0 && (ctx.store.one("SELECT COUNT(*) n FROM jobs WHERE session_id=?", sid).n as number) > before,
    );
    return c.snapshot(sid);
  };
  const close = async () => {
    clearInterval(approver);
    sessions.clear();
    controller.abort();
    await worker.catch(() => {});
    await ctx.app.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { name, dir, ctx, c, url, pin, withPin, session, card, exportedCard, importCard, publish, turn, open, idle, close };
}
export type A2ANode = Awaited<ReturnType<typeof a2aNode>>;
