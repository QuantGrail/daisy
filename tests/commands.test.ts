import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createApp } from "../packages/daisy/src/app.ts";
import { runNode } from "../packages/daisy/src/turns/worker.ts";
import { DaisyClient } from "../packages/client/src/index.ts";
import { runOperation } from "../packages/daisy/src/turns/operations.ts";
import { runCodex } from "../packages/daisy/src/harness/codex.ts";
import {
  redactConfig,
  readConfiguration,
  saveConfiguration,
} from "../packages/daisy/src/turns/configuration.ts";
import { runnerHeaders, runnerInject } from "./fixtures/runner-calls.ts";
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(read: () => Promise<T>, accept: (x: T) => boolean) {
  for (let i = 0; i < 150; i++) {
    const x = await read();
    if (accept(x)) return x;
    await delay(100);
  }
  throw Error("State timed out");
}
test("native management uses actual methods, validates config revisions and never edits host identities", async () => {
  const dir = mkdtempSync(join(tmpdir(), "daisy-native-ops-"));
  process.env.DAISY_CODEX_BIN = resolve("tests/fixtures/agent.cjs");
  const rt: any = {
    job: {
      id: "j",
      session: { agent: "codex", nativeId: "source" },
      profile: { configDir: dir, authMode: "subscription" },
      operation: { name: "catalog" },
    },
    cwd: dir,
    signal: new AbortController().signal,
    emit: () => {},
    flush: async () => {},
    approve: async () => ({ optionId: "deny" }),
    managedIdentity: true,
  };
  try {
    const catalog = await runOperation(rt);
    assert.equal(catalog.commands[0].name, "fixture-skill");
    rt.job.operation = { name: "fork", args: { sourceNativeId: "source" } };
    assert.equal((await runOperation(rt)).nativeId, "fork-source");
    rt.job.operation = { name: "rewind", args: { count: 1 } };
    assert.equal((await runOperation(rt)).thread.id, "source");
    // /compact runs in the session's own Agent process.
    rt.job.operation = { name: "compact" };
    const compacted = await runCodex({ ...rt, prompt: "/compact", files: [] });
    // N-4: the size Codex reported after it (nothing before in a new process).
    assert.equal(compacted.compact?.trigger, "manual");
    assert.equal(compacted.compact?.preTokens, undefined);
    assert.equal(compacted.compact?.postTokens, 5000);
    const before = readConfiguration(rt);
    saveConfiguration(
      rt,
      { model: "fixture", api_key: "private-test-secret" },
      before.version,
    );
    assert.throws(
      () => saveConfiguration(rt, { model: "overwritten" }, before.version),
      /配置已变化/,
    );
    assert.equal(
      redactConfig(readConfiguration(rt).value).api_key,
      "[保留原密钥]",
    );
    const current = readConfiguration(rt);
    saveConfiguration(
      rt,
      { ...redactConfig(current.value), model: "changed" },
      current.version,
    );
    assert.equal(readConfiguration(rt).value.api_key, "private-test-secret");
    rt.job.session.agent = "kimi";
    process.env.DAISY_KIMI_BIN = resolve("tests/fixtures/agent.cjs");
    rt.job.operation = { name: "catalog" };
    assert.equal((await runOperation(rt)).commands[0].name, "late-command");
    delete process.env.DAISY_KIMI_BIN;
    rt.job.operation = {
      name: "mcp.add",
      args: { name: "fixture", config: { command: "test-only", args: [] } },
    };
    await runOperation(rt);
    assert.equal(
      JSON.parse(readFileSync(join(dir, "mcp.json"), "utf8")).mcpServers.fixture
        .command,
      "test-only",
    );
    assert.equal(readConfiguration(rt).value.mcpServers, undefined);
    rt.managedIdentity = false;
    assert.throws(
      () => saveConfiguration(rt, {}, readConfiguration(rt).version),
      /独立身份/,
    );
  } finally {
    delete process.env.DAISY_CODEX_BIN;
    delete process.env.DAISY_KIMI_BIN;
    rmSync(dir, { recursive: true, force: true });
  }
});
test(
  "operations, queued input, live steer and terminal remain scoped, durable and mutually exclusive",
  { timeout: 60000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "daisy-commands-"));
    const { app, store, issueToken, runnerApi } = await createApp({ pinGate: false,
      dataDir: join(dir, "data"),
      workspaceHome: dir,
      workspaceRoots: [dir],
    });
  const inject = runnerInject(app, runnerApi);
    const url = await app.listen({ host: "127.0.0.1", port: 0 });
    const client = new DaisyClient(url, issueToken()),
      config = JSON.parse(readFileSync(join(dir, "data/runner.json"), "utf8"));
    config.api = runnerApi(config.nodeId);
    config.identityRoot = join(dir, "identities");
    for (const a of ["CLAUDE", "CODEX", "KIMI"])
      process.env[`DAISY_${a}_BIN`] = resolve("tests/fixtures/agent.cjs");
    const abort = new AbortController(),
      runner = runNode(config, abort.signal);
    try {
      const cat = await client.catalog(),
        p = cat.profiles.find((p) => p.agent === "codex")!;
      const s = await client.create({
        title: "commands",
        agent: "codex",
        profileId: p.id,
        workspaceId: cat.workspaces[0].id,
      });
      const op = await client.operation(
        s.id,
        "catalog",
        {},
        "catalog-idempotent",
      );
      assert.equal(
        (await client.operation(s.id, "catalog", {}, "catalog-idempotent")).id,
        op.id,
      );
      const info = await until(
        () => client.operationStatus(s.id, op.id),
        (r) => !!r.result,
      );
      assert.equal(info.result.models[0].id, "fixture-model");
      await until(
        () => client.snapshot(s.id),
        (x) => x.session.status === "idle",
      );
      await client.send(s.id, "WAIT_UNTIL_CANCEL", [], "hold-command");
      await until(
        () => client.snapshot(s.id),
        (x) => x.items.some((i) => i.name === "输入已交给 Codex"),
      );
      const live = await client.steer(
        s.id,
        "additional instruction",
        "live-idempotent",
      );
      assert.equal(
        (await client.steer(s.id, "additional instruction", "live-idempotent"))
          .id,
        live.id,
      );
      await until(
        () => client.snapshot(s.id),
        (x) =>
          x.items.some(
            (i) => i.id === `input:${live.id}` && i.status === "accepted",
          ),
      );
      // Follow-up 2026-11-09: Codex has no queue of its own — an answered
      // turn/steer is read (「Agent 已读取」).
      await until(
        () => client.snapshot(s.id),
        (x) =>
          x.items.some(
            (i) => i.id === `input:${live.id}` && i.delivery === "read",
          ),
      );
      const q = await client.send(
        s.id,
        "next message",
        [],
        "queued-idempotent",
        "queue",
      );
      assert.equal(q.status, "pending");
      assert.equal((await client.queue(s.id)).length, 1);
      await assert.rejects(() => client.operation(s.id, "fork"), /等待/);
      await client.removeQueued(s.id, q.id);
      assert.equal((await client.queue(s.id)).length, 0);
      const pending1 = await client.send(
        s.id,
        "queued one",
        [],
        "queue-promote-1",
        "queue",
      );
      const pending2 = await client.send(
        s.id,
        "queued two",
        [],
        "queue-promote-2",
        "queue",
      );
      await client.steer(s.id, "FINISH_HELD_TURN", "finish-held-turn");
      for (let n = 0; n < 2; n++) {
        const waiting = await until(
          () => client.snapshot(s.id),
          (x) => x.approvals.some((a) => a.status === "pending"),
        );
        const a = waiting.approvals.find((a) => a.status === "pending")!;
        await client.approve(s.id, a.id, a.options[0].id);
        await until(
          () => client.snapshot(s.id),
          (x) =>
            x.items.some(
              (i) =>
                i.id === `user:${n === 0 ? pending1.id : pending2.id}` &&
                i.status === "accepted",
            ),
        );
        await delay(400);
      }
      await until(
        () => client.snapshot(s.id),
        (x) => x.session.status === "idle",
      );
      assert.equal((await client.queue(s.id)).length, 0);
      // Create another held turn for terminal cancellation and ownership checks.
      await client.send(s.id, "WAIT_UNTIL_CANCEL", [], "hold-terminal");
      await until(
        () => client.snapshot(s.id),
        (x) => x.session.status === "running",
      );
      await client.cancel(s.id);
      await until(
        () => client.snapshot(s.id),
        (x) => x.session.status === "interrupted",
      );
      const terminal = await client.operation(s.id, "terminal");
      // The CLI's first words — after whatever the pseudo terminal says
      // first (Windows' ConPTY opens with its own mode sequences, P5-05).
      const text = (r: any) =>
        r.chunks.map((c: any) => Buffer.from(c.data, "base64").toString()).join("");
      const output = await until(
        () =>
          client.request(`/sessions/${s.id}/terminal/${terminal.id}/output`),
        (r) => /OFFICIAL CLI FIXTURE/.test(text(r)),
      );
      assert.match(text(output), /OFFICIAL CLI FIXTURE/);
      const body = { id: "terminal-input-once", text: "hello\r" };
      await client.request(
        `/sessions/${s.id}/terminal/${terminal.id}/input`,
        "POST",
        body,
      );
      await client.request(
        `/sessions/${s.id}/terminal/${terminal.id}/input`,
        "POST",
        body,
      );
      await until(
        () =>
          client.request(`/sessions/${s.id}/terminal/${terminal.id}/output`),
        (r) =>
          r.chunks.some((c: any) =>
            Buffer.from(c.data, "base64").toString().includes("CLI received:"),
          ),
      );
      assert.equal(
        store.one("SELECT COUNT(*) n FROM terminal_input WHERE id=?", body.id)
          .n,
        1,
      );
      await client.cancel(s.id);
      await until(
        () => client.snapshot(s.id),
        (x) => x.session.status === "interrupted",
      );
      process.env.DAISY_FIXTURE_FORK_ERROR = "1";
      const failedFork = await client.operation(s.id, "fork");
      await until(
        () => client.snapshot(failedFork.sessionId),
        (x) => x.session.status === "error",
      );
      delete process.env.DAISY_FIXTURE_FORK_ERROR;
      await assert.rejects(
        () => client.send(failedFork.sessionId, "not a new context"),
        /原生分叉尚未成功/,
      );
      const configWrite = await client.operation(s.id, "config.write", {
        value: { api_key: "only-in-encrypted-args" },
        version: "invalid",
      });
      const raw = store.one(
        "SELECT data FROM job_operations WHERE job_id=?",
        configWrite.id,
      ).data;
      assert.equal(raw.includes("only-in-encrypted-args"), false);
      assert.equal(
        JSON.parse(store.decrypt(JSON.parse(raw).encryptedArgs)).value.api_key,
        "only-in-encrypted-args",
      );
      await until(
        () => client.snapshot(s.id),
        (x) => x.session.status === "error",
      );
    } finally {
      delete process.env.DAISY_FIXTURE_FORK_ERROR;
      abort.abort();
      await runner;
      await app.close();
      for (const a of ["CLAUDE", "CODEX", "KIMI"])
        delete process.env[`DAISY_${a}_BIN`];
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test("configuration writes serialize against other work using the same identity across directories", async () => {
  const dir = mkdtempSync(join(tmpdir(), "daisy-identity-lock-"));
  const { app, store, issueToken, runnerApi } = await createApp({ pinGate: false,
    dataDir: dir,
    workspaceHome: dir,
    workspaceRoots: [dir],
  });
  const inject = runnerInject(app, runnerApi);
  try {
    const cfg = JSON.parse(readFileSync(join(dir, "runner.json"), "utf8"));
    const uh = {
        authorization: `Bearer ${issueToken()}`,
      },
      nh = runnerHeaders(cfg.nodeId);
    const call = async (url: string, payload: any = {}, headers: any = uh) =>
      (await inject({ method: "POST", url, payload, headers })).json();
    const cat = (
        await inject({ method: "GET", url: "/api/catalog", headers: uh })
      ).json(),
      p = cat.profiles.find((p: any) => p.agent === "codex");
    const s1 = await call("/api/sessions", {
      title: "first",
      agent: "codex",
      profileId: p.id,
      workspaceId: cat.workspaces[0].id,
    });
    const w2 = await call("/api/workspaces", {
      nodeId: p.nodeId,
      label: "other directory",
      path: join(dir, "other"),
    });
    const s2 = await call("/api/sessions", {
      title: "second",
      agent: "codex",
      profileId: p.id,
      workspaceId: w2.id,
    });
    const j = await call(`/api/sessions/${s1.id}/messages`, {
      text: "busy",
      requestId: "identity-busy-1",
    });
    const running = (await call("/api/runner/claim", {}, nh)).job;
    assert.equal(running.id, j.id);
    // P1-03: harness configuration is its own route (daisy:manage).
    const write = await call(`/api/sessions/${s2.id}/operations/harness`, {
      name: "config.write",
      args: { value: {}, version: "test" },
      requestId: "identity-config-1",
    });
    assert.equal((await call("/api/runner/claim", {}, nh)).job, null);
    await call(
      `/api/runner/jobs/${j.id}/complete`,
      { status: "idle" },
      { ...nh, "x-lease": running.lease },
    );
    const mutating = (await call("/api/runner/claim", {}, nh)).job;
    assert.equal(mutating.id, write.id);
    await call(`/api/sessions/${s1.id}/messages`, {
      text: "wait for config",
      requestId: "identity-busy-2",
    });
    assert.equal((await call("/api/runner/claim", {}, nh)).job, null);
    await call(
      `/api/runner/jobs/${mutating.id}/complete`,
      { status: "idle" },
      { ...nh, "x-lease": mutating.lease },
    );
    const normal = (await call("/api/runner/claim", {}, nh)).job;
    const queued = await call(`/api/sessions/${s1.id}/messages`, {
      text: "queued after failure",
      requestId: "resume-after-error",
      delivery: "queue",
    });
    assert.equal(queued.status, "pending");
    await call(
      `/api/runner/jobs/${normal.id}/complete`,
      { status: "error" },
      { ...nh, "x-lease": normal.lease },
    );
    assert.equal((await call("/api/runner/claim", {}, nh)).job, null);
    assert.equal(
      (await call(`/api/sessions/${s1.id}/queue/resume`)).id,
      queued.id,
    );
    assert.equal((await call("/api/runner/claim", {}, nh)).job.id, queued.id);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sessions in the same directory run in parallel (no per-workspace serialization)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "daisy-same-dir-"));
  const { app, store, issueToken, runnerApi } = await createApp({ pinGate: false,
    dataDir: dir,
    workspaceHome: dir,
    workspaceRoots: [dir],
  });
  const inject = runnerInject(app, runnerApi);
  try {
    const cfg = JSON.parse(readFileSync(join(dir, "runner.json"), "utf8"));
    const uh = {
        authorization: `Bearer ${issueToken()}`,
      },
      nh = runnerHeaders(cfg.nodeId);
    const call = async (url: string, payload: any = {}, headers: any = uh) =>
      (await inject({ method: "POST", url, payload, headers })).json();
    const cat = (
        await inject({ method: "GET", url: "/api/catalog", headers: uh })
      ).json(),
      p = cat.profiles.find((p: any) => p.agent === "codex"),
      workspaceId = cat.workspaces[0].id;
    const s1 = await call("/api/sessions", {
      title: "first",
      agent: "codex",
      profileId: p.id,
      workspaceId,
    });
    const s2 = await call("/api/sessions", {
      title: "second",
      agent: "codex",
      profileId: p.id,
      workspaceId,
    });
    const j1 = await call(`/api/sessions/${s1.id}/messages`, {
      text: "one",
      requestId: "same-dir-1",
    });
    const j2 = await call(`/api/sessions/${s2.id}/messages`, {
      text: "two",
      requestId: "same-dir-2",
    });
    assert.equal((await call("/api/runner/claim", {}, nh)).job.id, j1.id);
    assert.equal((await call("/api/runner/claim", {}, nh)).job.id, j2.id);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
