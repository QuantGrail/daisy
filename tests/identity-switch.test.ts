// 「换身份」 and the identity's Claude Code model slots — the API
// rules, the online process of the old identity retired once idle, the
// next turn started with the new identity's config directory and slots
// (the transcript carried over), and the Runner's copy rules.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  linkSync,
  writeFileSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createApp } from "../packages/daisy/src/app.ts";
import { id } from "../packages/daisy/src/store/index.ts";
import {
  carryDir,
  runNode,
  type NodeConfig,
} from "../packages/daisy/src/turns/worker.ts";
import { DaisyClient } from "../packages/client/src/index.ts";
import type { Snapshot } from "../packages/contracts/src/index.ts";
import { agentEnv } from "../packages/daisy/src/harness/shared.ts";
import { liveKey, retireReason } from "../packages/daisy/src/turns/live.ts";
import {
  CarryError,
  carryClaudeTranscript,
  claudeConfigDir,
} from "../packages/daisy/src/turns/transcript-carry.ts";
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
const SID = "0a2676ac-9a17-4d4e-9be7-b64e20f6d48c";

test("model slots: Claude identities only, validated, an empty slot clears it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "daisy-slots-"));
  const { app, store, issueToken } = await createApp({ pinGate: false,
    dataDir: dir,
    workspaceHome: dir,
    workspaceRoots: [dir],
  });
  try {
    const runner = JSON.parse(readFileSync(join(dir, "runner.json"), "utf8"));
    const headers = { authorization: `Bearer ${issueToken()}` };
    const req = (url: string, method: any = "GET", payload?: any) =>
      app.inject({ url: "/api" + url, method, payload, headers });
    const base = {
      nodeId: runner.nodeId,
      agent: "claude",
      authMode: "apiKey",
      apiKey: "k",
      baseUrl: "https://open.bigmodel.cn/api/anthropic",
    };
    const p = await req("/profiles", "POST", {
      ...base,
      label: "GLM max",
      modelSlots: {
        opus: "glm-5.3[1m]",
        sonnet: "",
        haiku: "glm-5.3-flash[1m]",
      },
    });
    assert.equal(p.statusCode, 200, p.body);
    assert.deepEqual(p.json().modelSlots, {
      opus: "glm-5.3[1m]",
      haiku: "glm-5.3-flash[1m]",
    });
    // A flag-looking or spaced name, an unknown slot, a Codex identity.
    for (const modelSlots of [{ opus: "-x" }, { opus: "a b" }, { mythos: "x" }])
      assert.equal(
        (await req("/profiles", "POST", { ...base, label: "bad", modelSlots }))
          .statusCode,
        400,
      );
    assert.equal(
      (
        await req("/profiles", "POST", {
          nodeId: runner.nodeId,
          agent: "codex",
          authMode: "subscription",
          label: "codex",
          modelSlots: { opus: "x" },
        })
      ).statusCode,
      400,
    );
    const pid = p.json().id;
    const patched = await req(`/profiles/${pid}`, "PATCH", {
      modelSlots: { opus: "glm-5.3[1m]", haiku: "" },
    });
    assert.equal(patched.statusCode, 200, patched.body);
    assert.deepEqual(patched.json().modelSlots, { opus: "glm-5.3[1m]" });
    // Other settings saves leave the slots alone.
    await req(`/profiles/${pid}`, "PATCH", { model: "glm-5.3" });
    assert.deepEqual(
      (await req("/catalog")).json().profiles.find((x: any) => x.id === pid)
        .modelSlots,
      { opus: "glm-5.3[1m]" },
    );
    const cleared = await req(`/profiles/${pid}`, "PATCH", {
      modelSlots: { opus: "" },
    });
    assert.equal(cleared.json().modelSlots, undefined);
    assert.ok(
      store.one(
        "SELECT 1 FROM audit WHERE action='profile.model-slots' AND target=?",
        pid,
      ),
    );
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("agentEnv: slots from the identity, the Runner's own never leak", () => {
  const before = process.env.ANTHROPIC_DEFAULT_SONNET_MODEL;
  process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = "runner-own";
  try {
    const job = (modelSlots?: any, agent = "claude") =>
      ({
        session: { agent, id: "s" },
        profile: {
          id: "p",
          authMode: "subscription",
          configDir: "",
          modelSlots,
        },
      }) as any;
    const env = agentEnv(job({ opus: "glm-5.3[1m]", fable: "" }));
    assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, "glm-5.3[1m]");
    assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, undefined);
    assert.equal(env.ANTHROPIC_DEFAULT_FABLE_MODEL, undefined);
    assert.equal(
      agentEnv(job({ opus: "x" }, "codex")).ANTHROPIC_DEFAULT_OPUS_MODEL,
      undefined,
    );
    // A slot change is a different process (it resumes the conversation).
    const k = (slots: any) =>
      liveKey(
        {
          session: { agent: "claude", id: "s" },
          profile: { id: "p", authMode: "subscription", modelSlots: slots },
        } as any,
        "/w",
      );
    assert.notEqual(k({ opus: "a" }), k({ opus: "b" }));
    assert.equal(k(undefined), k({}));
  } finally {
    if (before === undefined) delete process.env.ANTHROPIC_DEFAULT_SONNET_MODEL;
    else process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = before;
  }
});

test("carryClaudeTranscript: that conversation only, prefix or kept aside, links refused, capped", async () => {
  const root = mkdtempSync(join(tmpdir(), "daisy-carry-"));
  try {
    const a = join(root, "a"),
      b = join(root, "b"),
      proj = "-work-repo";
    const carry = (from: string, to: string, extra: any = {}) =>
      carryClaudeTranscript({
        fromDir: from,
        toDir: to,
        sessionId: SID,
        ...extra,
      });
    mkdirSync(join(a, "projects", proj, SID, "subagents"), { recursive: true });
    const srcFile = join(a, "projects", proj, `${SID}.jsonl`);
    writeFileSync(srcFile, "turn-1\n");
    writeFileSync(
      join(a, "projects", proj, SID, "subagents", "x.jsonl"),
      "sub\n",
    );
    writeFileSync(join(a, "projects", proj, "other.jsonl"), "not this one\n");
    symlinkSync("/etc/passwd", join(a, "projects", proj, SID, "link"));

    assert.deepEqual(await carry(a, b), { copied: 2, kept: [] });
    const dst = join(b, "projects", proj, `${SID}.jsonl`);
    assert.equal(readFileSync(dst, "utf8"), "turn-1\n");
    if (process.platform !== "win32") assert.equal(statSync(dst).mode & 0o777, 0o600);
    if (process.platform !== "win32") assert.equal(statSync(join(b, "projects", proj)).mode & 0o777, 0o700);
    assert.ok(
      existsSync(join(b, "projects", proj, SID, "subagents", "x.jsonl")),
    );
    assert.ok(!existsSync(join(b, "projects", proj, "other.jsonl")));
    assert.ok(!existsSync(join(b, "projects", proj, SID, "link")));

    // Same bytes: nothing. Turns under B since (A is B's prefix): left alone.
    assert.equal((await carry(a, b)).copied, 0);
    writeFileSync(dst, "turn-1\nturn-2\n");
    assert.equal((await carry(a, b)).copied, 0);
    assert.equal(readFileSync(dst, "utf8"), "turn-1\nturn-2\n");
    // Back to A: A's copy is a prefix of B's — replaced.
    assert.equal((await carry(b, a)).copied, 1);
    assert.equal(readFileSync(srcFile, "utf8"), "turn-1\nturn-2\n");

    // Diverged (e.g. typed in A's CLI, or rewound): the target is kept aside.
    writeFileSync(dst, "turn-1\nturn-2\nB-only\n");
    writeFileSync(srcFile, "turn-1\nturn-2\nA-only\n");
    const r = await carry(a, b, { now: Date.UTC(2026, 10, 3, 1, 2, 3) });
    assert.equal(r.copied, 1);
    assert.equal(r.kept.length, 1);
    assert.match(r.kept[0], /\.jsonl\.before-switch-2026-11-03T01-02-03-000Z$/);
    assert.equal(readFileSync(r.kept[0], "utf8"), "turn-1\nturn-2\nB-only\n");
    assert.equal(readFileSync(dst, "utf8"), "turn-1\nturn-2\nA-only\n");

    // Over the size limit: refused with a reason, nothing written.
    writeFileSync(srcFile, "x".repeat(4096));
    await assert.rejects(carry(a, b, { limit: 1024 }), (e: any) => {
      assert.ok(e instanceof CarryError);
      assert.match(e.message, /超过 .* MiB 的上限/);
      return true;
    });
    assert.equal(readFileSync(dst, "utf8"), "turn-1\nturn-2\nA-only\n");

    // A hard-linked transcript, a symlinked one, a symlinked project folder
    // on the target side: refused.
    const c = join(root, "c");
    mkdirSync(join(c, "projects", proj), { recursive: true });
    linkSync(srcFile, join(c, "projects", proj, `${SID}.jsonl`));
    await assert.rejects(carry(c, join(root, "c2")), CarryError);
    const d = join(root, "d");
    mkdirSync(join(d, "projects", proj), { recursive: true });
    symlinkSync(srcFile, join(d, "projects", proj, `${SID}.jsonl`));
    await assert.rejects(carry(d, join(root, "d2")), /符号链接/);
    const e = join(root, "e");
    mkdirSync(join(e, "projects"), { recursive: true });
    symlinkSync(join(root, "elsewhere"), join(e, "projects", proj));
    mkdirSync(join(root, "elsewhere"));
    writeFileSync(srcFile, "turn-1\n");
    await assert.rejects(carry(a, e), /符号链接/);
    assert.ok(!existsSync(join(root, "elsewhere", `${SID}.jsonl`)));

    // Not a session id / not under the old identity / same directory.
    await assert.rejects(
      carryClaudeTranscript({ fromDir: a, toDir: b, sessionId: "../x" }),
      /会话 ID 无效/,
    );
    await assert.rejects(
      carry(join(root, "none"), b),
      /旧身份的配置目录不存在/,
    );
    mkdirSync(join(root, "empty"));
    await assert.rejects(carry(join(root, "empty"), join(root, "f")), /找不到/);
    assert.equal(
      (await carry(join(root, "empty"), b)).skipped,
      "新身份里已有这段对话",
    );
    assert.equal((await carry(a, a)).skipped, "同一个配置目录");
    assert.equal(claudeConfigDir("/x"), "/x");
    assert.equal(claudeConfigDir("", { CLAUDE_CONFIG_DIR: "/y" } as any), "/y");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("carryDir: a managed old identity resolves to its own directory, never created", () => {
  const root = mkdtempSync(join(tmpdir(), "daisy-carrydir-"));
  try {
    const cfg = { nodeId: "node-1", identityRoot: root };
    assert.deepEqual(carryDir({ profileId: "p", configDir: "/x" }, cfg), {
      profileId: "p",
      configDir: "/x",
    });
    // Deleted (its directory removed): nothing to carry, and not recreated.
    assert.equal(
      carryDir({ profileId: "p1", configDir: "managed:p1" }, cfg),
      undefined,
    );
    assert.ok(!existsSync(join(root, "node-1", "p1")));
    mkdirSync(join(root, "node-1", "p1"), { recursive: true });
    assert.deepEqual(
      carryDir({ profileId: "p1", configDir: "managed:p1" }, cfg),
      {
        profileId: "p1",
        configDir: join(root, "node-1", "p1"),
      },
    );
    // Someone else's managed directory, or a path in the id: refused.
    assert.equal(
      carryDir({ profileId: "p2", configDir: "managed:p1" }, cfg),
      undefined,
    );
    assert.equal(
      carryDir({ profileId: "../p1", configDir: "managed:../p1" }, cfg),
      undefined,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  "换身份: rules, the old process retired once idle, the next turn resumes under the new identity",
  { timeout: 60000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "daisy-switch-"));
    const ctx = await createApp({ pinGate: false,
      workspaceHome: dir,
      workspaceRoots: [dir],
      dataDir: dir,
    });
    const url = await ctx.app.listen({ host: "127.0.0.1", port: 0 });
    const c = new DaisyClient(url, ctx.issueToken());
    const config: NodeConfig = {
      ...runnerConfig(ctx, join(dir, "runner.json")),
      concurrency: 2,
      // Spawn records are told apart by DAISY_TEST_SESSION (P4-13: the test-only plugin tests/plugins/session-tag).
      plugins: ["session-tag"],
    };
    const spawns = join(dir, "spawns.jsonl");
    process.env.DAISY_CLAUDE_BIN = resolve("tests/fixtures/agent.cjs");
    process.env.DAISY_FIXTURE_ENV_FILE = spawns;
    config.identityRoot ??= join(dir, "runner-state-root");
    const controller = new AbortController();
    const worker = runNode(config, controller.signal);
    const call = (
      path: string,
      method = "GET",
      body?: any,
      token = ctx.issueToken(),
    ) =>
      fetch(url + "/api" + path, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    const dirA = join(dir, "id-a"),
      dirB = join(dir, "id-b");
    try {
      const mk = async (label: string, extra: any) =>
        (
          await (
            await call("/profiles", "POST", {
              nodeId: config.nodeId,
              agent: "claude",
              authMode: "subscription",
              label,
              ...extra,
            })
          ).json()
        ).id as string;
      const a = await mk("官方订阅", { configDir: dirA });
      const b = await mk("GLM max", {
        configDir: dirB,
        modelSlots: { opus: "glm-5.3[1m]", haiku: "glm-5.3-flash[1m]" },
      });
      const codex = await mk("codex", { agent: "codex" });
      const cat = await c.catalog();
      const s = await c.create({
        agent: "claude",
        title: "switch",
        profileId: a,
        workspaceId: cat.workspaces[0].id,
      });
      const turn = async (text: string) => {
        await c.send(s.id, text);
        const waiting = await until(
          () => c.snapshot(s.id),
          (x) => x.approvals.some((p) => p.status === "pending") || idle(x),
        );
        const ap = waiting.approvals.find((p) => p.status === "pending");
        if (ap) await c.approve(s.id, ap.id, ap.options[0].id);
        return until(
          () => c.snapshot(s.id),
          (x) => idle(x) && !x.approvals.some((p) => p.status === "pending"),
        );
      };
      const quiet = (x: Snapshot) =>
        !!x.session.live?.online &&
        !x.session.live.busy &&
        !x.session.live.pending?.length;
      const first = await turn("hello");
      const nativeId = first.session.nativeId!;
      assert.ok(nativeId);
      await until(() => c.snapshot(s.id), quiet);
      // Claude Code's transcript of this conversation under identity A.
      const proj = join(dirA, "projects", "-work");
      mkdirSync(proj, { recursive: true });
      writeFileSync(join(proj, `${nativeId}.jsonl`), '{"type":"user"}\n');
      const sw = (profileId: string, token?: string) =>
        call(`/sessions/${s.id}/identity`, "POST", { profileId }, token);

      // Rules: same Agent, same node, the owner's, nothing running.
      assert.equal((await sw(codex)).status, 400);
      assert.equal((await sw("nope")).status, 404);
      // A running row holds a lease, as a real one does: without it
      // (lease_until 0) the queue's reaper settles it as 「执行节点失联」 at
      // its next tick — under load that tick came before the switch was
      // asked and the switch went through (the macOS flake, P5-04).
      const job = (status: string, op?: string) => {
        const jid = id();
        ctx.store.run(
          "INSERT INTO jobs(id,session_id,node_id,request_id,text,attachments,status,created,context,terminal,lease_until) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
          jid,
          s.id,
          config.nodeId,
          "busy-" + jid,
          "x",
          "[]",
          status,
          Date.now(),
          null,
          null,
          status === "running" ? Date.now() + 10 * 60_000 : 0,
        );
        if (op)
          ctx.store.run(
            "INSERT INTO job_operations(job_id,data) VALUES(?,?)",
            jid,
            JSON.stringify({ name: op }),
          );
        return jid;
      };
      let jid = job("queued");
      assert.equal((await sw(b)).status, 409);
      ctx.store.run("DELETE FROM jobs WHERE id=?", jid);
      // An open native CLI (a running terminal job): its own reason.
      jid = job("running", "terminal");
      const term = await sw(b);
      assert.equal(term.status, 409);
      assert.equal((await term.json()).code, "terminal_open");
      ctx.store.run("DELETE FROM job_operations WHERE job_id=?", jid);
      ctx.store.run("DELETE FROM jobs WHERE id=?", jid);
      // An Agent-started turn or background work has no job row.
      // A real busy process: the fake CLI's background task keeps the
      // online process pending after its turn (no job row): live_busy.
      process.env.DAISY_FIXTURE_WAKE_MS = "15000";
      const bg = await c.create({
        agent: "claude",
        title: "background",
        profileId: a,
        workspaceId: cat.workspaces[0].id,
      });
      await c.send(bg.id, "BG_TEST");
      await until(
        () => c.snapshot(bg.id),
        (x) =>
          idle(x) && !!x.session.live?.pending?.some((p) => p.kind === "task"),
      );
      const bgSwitch = await call(`/sessions/${bg.id}/identity`, "POST", {
        profileId: b,
      });
      assert.equal(bgSwitch.status, 409);
      assert.equal((await bgSwitch.json()).code, "live_busy");
      delete process.env.DAISY_FIXTURE_WAKE_MS;

      await c.updateSession(s.id, {
        settings: { model: "opus", reasoningEffort: "high" },
      });
      const first1 = await sw(b);
      assert.equal(first1.status, 200, await first1.clone().text());
      const after = await first1.json();
      assert.equal(after.profileId, b);
      assert.equal(after.identityMove.from, a);
      assert.deepEqual(after.settings, { reasoningEffort: "high" });
      // A→B→C before any turn: the transcript is still A's, so A stays the
      // origin; back to A forgets the switch. (The transaction itself:
      // tests/identity-switch-rules.test.ts.)
      const cId = await mk("GLM pro", { configDir: join(dir, "id-c") });
      assert.equal((await (await sw(cId)).json()).identityMove.from, a);
      assert.equal((await (await sw(a)).json()).identityMove, undefined);
      assert.equal((await (await sw(b)).json()).identityMove.from, a);

      // The old identity's process goes offline once idle.
      const off = await until(
        () => c.snapshot(s.id),
        (x) => x.session.live?.online === false,
      );
      assert.equal(off.session.live?.reason, retireReason());
      assert.ok(
        off.items.some(
          (i) =>
            i.kind === "notice" &&
            /身份已从「官方订阅」切换到「GLM max」/.test(i.text || ""),
        ),
      );
      // A is still needed (its directory holds the transcript): no delete.
      const busyDelete = await call(`/profiles/${a}`, "DELETE");
      assert.equal(busyDelete.status, 409);
      assert.match((await busyDelete.json()).error, /对话记录还没带到新身份/);

      // Not only turns: an operation is the first Claude command here — it
      // carries the transcript, and the switch is then forgotten (once).
      await c.operation(s.id, "config.read", {}, "carry-op-1");
      await until(
        () => c.snapshot(s.id),
        (x) => !x.session.identityMove && idle(x),
      );
      const carried = join(dirB, "projects", "-work", `${nativeId}.jsonl`);
      assert.equal(readFileSync(carried, "utf8"), '{"type":"user"}\n');
      assert.ok(
        (await c.snapshot(s.id)).items.some((i) =>
          /换身份：已把这段对话的记录带到新身份/.test(i.name || ""),
        ),
      );
      // A changes afterwards (its own CLI, say): never copied over B again.
      writeFileSync(join(proj, `${nativeId}.jsonl`), "A later\n");

      // The next turn: identity B's directory and slots, resuming the same
      // conversation from B's own copy.
      await turn("again");
      const runs = readFileSync(spawns, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l))
        .filter((x) => x.DAISY_TEST_SESSION === s.id && x.argv.includes("-p"));
      const last = runs.at(-1)!;
      assert.equal(last.CLAUDE_CONFIG_DIR, dirB);
      assert.equal(last.ANTHROPIC_DEFAULT_OPUS_MODEL, "glm-5.3[1m]");
      assert.equal(last.ANTHROPIC_DEFAULT_HAIKU_MODEL, "glm-5.3-flash[1m]");
      assert.deepEqual(
        last.argv.slice(
          last.argv.indexOf("--resume"),
          last.argv.indexOf("--resume") + 2,
        ),
        ["--resume", nativeId],
      );
      assert.equal(runs[0].CLAUDE_CONFIG_DIR, dirA);
      assert.equal(readFileSync(carried, "utf8"), '{"type":"user"}\n');
      // Carried and no process left: A can go now.
      assert.equal((await call(`/profiles/${a}`, "DELETE")).status, 200);
    } finally {
      controller.abort();
      await worker.catch(() => {});
      await ctx.app.close();
      delete process.env.DAISY_CLAUDE_BIN;
      delete process.env.DAISY_FIXTURE_ENV_FILE;
      delete process.env.DAISY_FIXTURE_WAKE_MS;
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
