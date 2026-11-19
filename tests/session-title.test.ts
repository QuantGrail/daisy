import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createApp } from "../packages/daisy/src/app.ts";
import { hash, id } from "../packages/daisy/src/store/index.ts";
import { runNode, type NodeConfig } from "../packages/daisy/src/turns/worker.ts";
import { DaisyClient } from "../packages/client/src/index.ts";
import type { Snapshot } from "../packages/contracts/src/index.ts";
import {
  untitledTitle,
  fallbackTitle,
  sanitizeTitle,
  sessionTitlePrompt,
} from "../packages/contracts/src/title.ts";
import {
  generateTitle,
  setTitleRunner,
  suggestTitle,
  titleCommand,
} from "../packages/daisy/src/turns/title.ts";
import { runnerConfig } from "./fixtures/runner-calls.ts";
// P6-24: the placeholder in the language these sessions speak (zh-CN in tests).
const UNTITLED = untitledTitle("zh-CN");
import { runnerHeaders, runnerInject } from "./fixtures/runner-calls.ts";
import { OWNER_ID } from "../packages/daisy/src/access/owner.ts";

// Conversation titles (revised 2026-10-30): an untitled conversation is
// named at once by its first sentence (a placeholder, not AI); after the
// second completed round the Runner asks the user's own CLI for one final
// title from the first two rounds, retried once after round 3 on failure.
// No AI title after round 1; a hand-edited title is never replaced.

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("fallback title: first meaningful line, no markdown noise, cut", () => {
  assert.equal(fallbackTitle(""), UNTITLED);
  assert.equal(
    fallbackTitle("\n\n  # 帮我看 **GRM** 回测\n详情"),
    "帮我看 GRM 回测",
  );
  assert.equal(
    fallbackTitle("@codex 看下 `pnl.py` 的 bug"),
    "看下 pnl.py 的 bug",
  );
  const long = fallbackTitle("一".repeat(40));
  assert.ok(long.endsWith("…") && long.length <= 20, long);
  assert.ok(fallbackTitle("a".repeat(100)).length <= 40);
});

test("sanitize a suggested title", () => {
  assert.equal(sanitizeTitle("  「核查回测版本。」\n多余"), "核查回测版本");
  assert.equal(sanitizeTitle("标题：GRM 对比"), "GRM 对比");
  // A model that copied the prompt's example format.
  assert.equal(
    sanitizeTitle("好：GRM 回测窗口差异排查 / 差：帮我看看"),
    "GRM 回测窗口差异排查",
  );
  assert.equal(sanitizeTitle("\n\n"), "");
});

test("two-round prompt: both asks and replies, cut sensibly, with examples", () => {
  const p = sessionTitlePrompt([
    {
      user: "帮我看看 GRM 8 月回测为什么和上周不一样\n" + "细节".repeat(2000),
      reply: "先对比两版输出。" + "中间".repeat(2000) + "结论：数据窗口改了。",
    },
    {
      user:
        "那就按新窗口重跑并画夏普对比图\n```py\n" + "x=1\n".repeat(200) + "```",
      reply: "已重跑，图在 sharpe.png。",
    },
    { user: "第三轮不该出现", reply: "不该出现" },
  ]);
  // The title follows the person's language, stated outright.
  assert.match(p, /用户用中文写：标题用中文，4 到 14 个字/);
  assert.doesNotMatch(p, /用户用英文写/);
  const en = sessionTitlePrompt([
    { user: "why does the CI build fail on the release branch?", reply: "x" },
    { user: "bump node to 24 (回测 not involved)", reply: "y" },
  ]);
  assert.match(en, /标题必须是英文，不超过 6 个词/);
  assert.match(p, /不要复述或截取用户的第一句话/);
  assert.match(p, /「对话」「会话」「帮助」/);
  assert.match(p, /好：GRM 回测窗口差异排查 \/ 差：/);
  assert.match(p, /<round n="1">[\s\S]*GRM 8 月回测[\s\S]*<round n="2">/);
  // Head and tail of a long reply both survive (the ask and the conclusion).
  assert.match(p, /先对比两版输出[\s\S]*……[\s\S]*数据窗口改了/);
  assert.match(p, /夏普对比图/);
  assert.match(p, /\[代码 py\]/);
  assert.match(p, /sharpe\.png/);
  assert.doesNotMatch(p, /第三轮不该出现/);
  assert.ok(p.length < 4500, String(p.length));
});

test("runner asks the same CLI headless and cleans its answer", async () => {
  const job: any = {
    session: { id: "s1", agent: "claude" },
    profile: { model: "", baseUrl: "", configDir: "/x/claude-home" },
  };
  const c = titleCommand(job, "P", "/tmp/o")!;
  assert.deepEqual(c.args.slice(0, 4), ["-p", "P", "--model", "haiku"]);
  assert.ok(c.args.includes("--no-session-persistence"));
  // A namer, not a coding agent: Claude Code's own system prompt is replaced.
  assert.match(c.args[c.args.indexOf("--system-prompt") + 1], /只输出/);
  const codex = titleCommand(
    { ...job, session: { id: "s1", agent: "codex" } },
    "P",
    "/tmp/o",
  )!;
  assert.ok(
    codex.args.includes("--ephemeral") && codex.args.includes("read-only"),
  );
  assert.equal(
    titleCommand({ ...job, session: { id: "s1", agent: "kimi" } }, "P", "/o"),
    null,
  );
  let seen: any;
  setTitleRunner(async (bin, args, o) => {
    seen = { bin, args, env: o.env, cwd: o.cwd, timeoutMs: o.timeoutMs };
    return "“修窗版回测对比。”\n";
  });
  try {
    const t = await generateTitle(job, { prompt: "两轮" });
    assert.equal(t, "修窗版回测对比");
    assert.equal(seen.args[1], "两轮");
    assert.equal(seen.timeoutMs, 45_000);
    // Billed to the conversation's own identity, outside any project.
    assert.equal(seen.env.CLAUDE_CONFIG_DIR, "/x/claude-home");
    assert.equal(seen.env.DAISY_TEST_SESSION, undefined);
    assert.match(seen.cwd, /daisy-title-/);
    // A failure (timeout, empty answer) is reported as "" once.
    setTitleRunner(async () => {
      throw Error("timeout");
    });
    await assert.rejects(generateTitle(job, { prompt: "x" }));
    const reports: string[] = [];
    await suggestTitle(job, { prompt: "x" }, async (r) => reports.push(r));
    setTitleRunner(async () => "\n");
    await suggestTitle(job, { prompt: "x" }, async (r) => reports.push(r));
    assert.deepEqual(reports, ["", ""]);
  } finally {
    setTitleRunner();
  }
});

/** Control plane only: the Runner side is played through the node API. */
async function plane() {
  const dir = mkdtempSync(join(tmpdir(), "daisy-title-"));
  const { app, store, issueToken, runnerApi } = await createApp({ pinGate: false,
    dataDir: dir,
    workspaceHome: dir,
    workspaceRoots: [dir],
  });
  const inject = runnerInject(app, runnerApi);
  const u = OWNER_ID;
  const h = { authorization: `Bearer ${issueToken()}` };
  const runner = JSON.parse(readFileSync(join(dir, "runner.json"), "utf8"));
  const nh = runnerHeaders(runner.nodeId);
  const call = (
    method: any,
    url: string,
    payload?: any,
    headers: Record<string, string> = h,
  ) => inject({ method, url, payload, headers });
  /** The node's Runner reports what it can do (current code: titles v2). */
  const beat = (capabilities: any = { sessionTitles: { version: 2 } }) =>
    call("POST", "/api/runner/sync", { capabilities }, nh);
  await beat();
  const cat = (await call("GET", "/api/catalog")).json();
  const base = (agent = "claude") => ({
    agent,
    workspaceId: cat.workspaces[0].id,
    profileId: cat.profiles.find((p: any) => p.agent === agent).id,
  });
  const snap = async (sid: string) =>
    (await call("GET", `/api/sessions/${sid}`)).json().session;
  let n = 0;
  /** One round: send, claim, the AI answers, complete; the receipt. */
  const round = async (sid: string, text: string, reply = `答：${text}`) => {
    await call("POST", `/api/sessions/${sid}/messages`, {
      text,
      requestId: `title-msg-${++n}`,
    });
    const job = (await call("POST", "/api/runner/claim", {}, nh)).json().job;
    assert.ok(job, "a job to claim");
    const jh = { ...nh, "x-lease": job.lease };
    await call(
      "POST",
      `/api/runner/jobs/${job.id}/events`,
      {
        events: [
          {
            id: id(),
            type: "item",
            data: {
              id: `${job.id}:a`,
              kind: "assistant",
              text: reply,
              createdAt: Date.now(),
            },
          },
        ],
      },
      jh,
    );
    const receipt = (
      await call(
        "POST",
        `/api/runner/jobs/${job.id}/complete`,
        { status: "idle" },
        jh,
      )
    ).json();
    return { receipt, job, jh };
  };
  const title = (sid: string, body: any, headers = nh) =>
    call("POST", `/api/runner/sessions/${sid}/title`, body, headers);
  const create = async (extra: any = {}) =>
    (await call("POST", "/api/sessions", { ...base(), ...extra })).json();
  const close = async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { app, store, u, call, beat, base, snap, round, title, create, close };
}

test("server: placeholder at once, no AI title after round 1, one final title after round 2", async () => {
  const t = await plane();
  try {
    // Untitled; a retry with the same body is the same session.
    const s = await t.create({ requestId: "title-rq-1" });
    assert.equal(s.title, UNTITLED);
    assert.equal(s.titleAuto, true);
    assert.equal((await t.create({ requestId: "title-rq-1" })).id, s.id);
    const named = await t.create({ title: "我起的名字" });
    assert.equal(named.titleAuto, false);
    assert.equal(named.titleStage, "manual");

    // Round 1: the first sentence at once, and no AI call at all.
    const r1 = await t.round(
      s.id,
      "## 帮我复核 GRM 8 月回测\n细节…",
      "好的，先找两个版本的输出。",
    );
    assert.equal((await t.snap(s.id)).title, "帮我复核 GRM 8 月回测");
    assert.equal(r1.receipt.titleRequest, undefined);
    assert.equal((await t.snap(s.id)).titleTries, undefined);

    // Round 2: one request built from both rounds.
    const r2 = await t.round(s.id, "那按新窗口重跑", "已重跑，夏普 1.8。");
    const req = r2.receipt.titleRequest;
    assert.equal(req.stage, "final");
    assert.equal(req.attempt, 1);
    for (const part of ["GRM 8 月回测", "两个版本", "按新窗口重跑", "夏普 1.8"])
      assert.ok(req.prompt.includes(part), part);
    // A replayed completion (lost receipt) repeats it without a new attempt.
    const again = (
      await t.call(
        "POST",
        `/api/runner/jobs/${r2.job.id}/complete`,
        { status: "idle" },
        r2.jh,
      )
    ).json();
    assert.equal(again.titleRequest.prompt, req.prompt);
    assert.equal((await t.snap(s.id)).titleTries, 1);

    // Another node cannot name it; its own node can, once.
    const other = id();
    t.store.run(
      "INSERT INTO nodes(id,label,token_hash,owner_id) VALUES(?,?,?,?)",
      other,
      "other",
      hash("other-node-token"),
      t.u,
    );
    assert.equal(
      (
        await t.title(
          s.id,
          { title: "坏" },
          runnerHeaders(other),
        )
      ).statusCode,
      404,
    );
    assert.deepEqual(
      (
        await t.title(s.id, { title: "「GRM 回测窗口复核」", stage: "final" })
      ).json(),
      { ok: true, applied: true, title: "GRM 回测窗口复核" },
    );
    const after = await t.snap(s.id);
    assert.equal(after.title, "GRM 回测窗口复核");
    assert.equal(after.titleAuto, false);
    assert.equal(after.titleStage, "final");

    // Never generated again: no request at round 3, a late title is ignored.
    assert.equal(
      (await t.round(s.id, "第三轮")).receipt.titleRequest,
      undefined,
    );
    assert.equal(
      (await t.title(s.id, { title: "再改", stage: "final" })).json().applied,
      false,
    );
    assert.equal((await t.snap(s.id)).title, "GRM 回测窗口复核");

    // A titled session asks nothing, at any round.
    assert.equal(
      (await t.round(named.id, "hi")).receipt.titleRequest,
      undefined,
    );
    assert.equal(
      (await t.round(named.id, "hi2")).receipt.titleRequest,
      undefined,
    );
  } finally {
    await t.close();
  }
});

test("server: a failed attempt is retried once after round 3, then the placeholder stays", async () => {
  const t = await plane();
  try {
    const s = await t.create();
    await t.round(s.id, "整理 Daisy 会话命名的需求");
    const r2 = await t.round(s.id, "再补上失败重试");
    assert.equal(r2.receipt.titleRequest.attempt, 1);
    // The Runner reports the failure (CLI timeout): the placeholder stays.
    assert.equal(
      (await t.title(s.id, { title: "", failed: true })).json().applied,
      false,
    );
    assert.equal((await t.snap(s.id)).title, "整理 Daisy 会话命名的需求");
    const r3 = await t.round(s.id, "第三轮的新话题不进标题");
    assert.equal(r3.receipt.titleRequest.attempt, 2);
    // Still from the first two rounds only.
    assert.ok(r3.receipt.titleRequest.prompt.includes("失败重试"));
    assert.ok(!r3.receipt.titleRequest.prompt.includes("第三轮的新话题"));
    await t.title(s.id, { title: "", failed: true });
    assert.equal(
      (await t.round(s.id, "第四轮")).receipt.titleRequest,
      undefined,
    );
    assert.equal(
      (await t.round(s.id, "第五轮")).receipt.titleRequest,
      undefined,
    );
    const end = await t.snap(s.id);
    assert.equal(end.title, "整理 Daisy 会话命名的需求");
    assert.equal(end.titleAuto, true);
    assert.equal(end.titleTries, 2);

    // An attempt still running (no answer yet) is not doubled by the next round.
    const p = await t.create();
    await t.round(p.id, "一");
    assert.ok((await t.round(p.id, "二")).receipt.titleRequest);
    assert.equal((await t.round(p.id, "三")).receipt.titleRequest, undefined);
    assert.equal((await t.snap(p.id)).titleTries, 1);
  } finally {
    await t.close();
  }
});

test("server: a hand-edited title blocks every stage", async () => {
  const t = await plane();
  try {
    // Renamed after round 1: no request at round 2 or 3.
    const a = await t.create();
    await t.round(a.id, "第一句");
    await t.call("PATCH", `/api/sessions/${a.id}`, { title: "手动" });
    assert.equal((await t.snap(a.id)).titleStage, "manual");
    assert.equal((await t.round(a.id, "二")).receipt.titleRequest, undefined);
    assert.equal((await t.round(a.id, "三")).receipt.titleRequest, undefined);
    assert.equal((await t.snap(a.id)).title, "手动");

    // Renamed while the attempt runs: the late AI title is not applied.
    const b = await t.create();
    await t.round(b.id, "第一句");
    assert.ok((await t.round(b.id, "二")).receipt.titleRequest);
    await t.call("PATCH", `/api/sessions/${b.id}`, { title: "我的名字" });
    assert.equal(
      (await t.title(b.id, { title: "AI 的名字", stage: "final" })).json()
        .applied,
      false,
    );
    assert.equal((await t.snap(b.id)).title, "我的名字");
    assert.equal((await t.round(b.id, "三")).receipt.titleRequest, undefined);

    // Renamed before any message: the first sentence does not replace it.
    const c = await t.create();
    await t.call("PATCH", `/api/sessions/${c.id}`, { title: "先起好" });
    await t.round(c.id, "第一句");
    assert.equal((await t.snap(c.id)).title, "先起好");
  } finally {
    await t.close();
  }
});

test("server: a Runner on older code is not asked and uses up no attempt", async () => {
  const t = await plane();
  try {
    await t.beat({}); // the node runs a Runner from before this release
    const s = await t.create();
    await t.round(s.id, "老 Runner 上的会话");
    assert.equal(
      (await t.round(s.id, "第二轮")).receipt.titleRequest,
      undefined,
    );
    assert.equal(
      (await t.round(s.id, "第三轮")).receipt.titleRequest,
      undefined,
    );
    assert.equal((await t.snap(s.id)).titleTries, undefined);
    // Restarted into the current release: the next round names it, from
    // the first two rounds.
    await t.beat();
    const r = (await t.round(s.id, "第四轮")).receipt.titleRequest;
    assert.equal(r.attempt, 1);
    assert.ok(
      r.prompt.includes("老 Runner 上的会话") && r.prompt.includes("第二轮"),
    );
    assert.ok(!r.prompt.includes("第四轮"));

    // Kimi has no headless mode: never asked.
    await t.beat();
    const k = await t.create(t.base("kimi"));
    await t.round(k.id, "一");
    assert.equal((await t.round(k.id, "二")).receipt.titleRequest, undefined);
  } finally {
    await t.close();
  }
});

/** Real Runner + fake CLI (tests/fixtures/agent.cjs title mode). */
async function withRunner(
  titles: string,
  body: (x: {
    c: DaisyClient;
    sid: string;
    turn: (text: string) => Promise<Snapshot>;
    calls: () => { prompt: string; argv: string[] }[];
  }) => Promise<void>,
) {
  const dir = mkdtempSync(join(tmpdir(), "daisy-title-e2e-"));
  const ctx = await createApp({ pinGate: false,
    workspaceHome: dir,
    workspaceRoots: [dir],
    dataDir: dir,
  });
  const inject = runnerInject(ctx.app, ctx.runnerApi);
  const url = await ctx.app.listen({ host: "127.0.0.1", port: 0 });
  const c = new DaisyClient(
    url,
    ctx.issueToken(),
  );
  const config: NodeConfig = {
    ...runnerConfig(ctx, join(dir, "runner.json")),
  };
  const log = join(dir, "titles.jsonl");
  const env = {
    DAISY_CLAUDE_BIN: resolve("tests/fixtures/agent.cjs"),
    DAISY_FIXTURE_TITLES: titles,
    DAISY_FIXTURE_TITLE_LOG: log,
  };
  Object.assign(process.env, env);
  const controller = new AbortController();
  // Runner state (result journal, restart requests) under the test dir.
  config.identityRoot ??= join(dir, "runner-state-root");
  const worker = runNode(config, controller.signal);
  try {
    const cat = await c.catalog();
    const s = await c.create({
      agent: "claude",
      profileId: cat.profiles.find((p) => p.agent === "claude")!.id,
      workspaceId: cat.workspaces[0].id,
    });
    const until = async (accept: (x: Snapshot) => boolean) => {
      for (let i = 0; i < 150; i++) {
        const x = await c.snapshot(s.id);
        if (accept(x)) return x;
        await delay(100);
      }
      throw Error("State timed out");
    };
    const idle = (x: Snapshot) =>
      !["queued", "running", "waiting"].includes(x.session.status);
    const turn = async (text: string) => {
      await c.send(s.id, text);
      const w = await until(
        (x) => x.approvals.some((a) => a.status === "pending") || idle(x),
      );
      const a = w.approvals.find((a) => a.status === "pending");
      if (a) await c.approve(s.id, a.id, a.options[0].id);
      return until(
        (x) => idle(x) && !x.approvals.some((a) => a.status === "pending"),
      );
    };
    const calls = () =>
      existsSync(log)
        ? readFileSync(log, "utf8")
            .trim()
            .split("\n")
            .map((l) => JSON.parse(l))
        : [];
    await body({ c, sid: s.id, turn, calls });
  } finally {
    controller.abort();
    await worker.catch(() => {});
    await ctx.app.close();
    for (const k of Object.keys(env)) delete process.env[k];
    rmSync(dir, { recursive: true, force: true });
  }
}

test(
  "runner + fake CLI: no call after round 1, the final title after round 2, never again",
  { timeout: 60000 },
  async () => {
    await withRunner(
      "「GRM 回测窗口排查」。",
      async ({ c, sid, turn, calls }) => {
        await turn("帮我看看 GRM 回测为什么变了");
        await delay(1500); // a call would have started by now
        assert.equal(calls().length, 0);
        assert.equal(
          (await c.snapshot(sid)).session.title,
          "帮我看看 GRM 回测为什么变了",
        );
        await turn("按 8 月新窗口重跑");
        for (
          let i = 0;
          i < 100 && (await c.snapshot(sid)).session.titleAuto;
          i++
        )
          await delay(100);
        const s = (await c.snapshot(sid)).session;
        assert.equal(s.title, "GRM 回测窗口排查");
        assert.equal(s.titleStage, "final");
        const [call] = calls();
        assert.equal(calls().length, 1);
        assert.ok(call.argv.includes("haiku"));
        assert.ok(
          call.prompt.includes("GRM 回测为什么变了") &&
            call.prompt.includes("按 8 月新窗口重跑"),
        );
        await turn("第三轮");
        await delay(1500);
        assert.equal(calls().length, 1);
        assert.equal((await c.snapshot(sid)).session.title, "GRM 回测窗口排查");
      },
    );
  },
);

test(
  "runner + fake CLI: a failed call keeps the placeholder and is retried once after round 3",
  { timeout: 60000 },
  async () => {
    await withRunner("fail|数据管线重构", async ({ c, sid, turn, calls }) => {
      await turn("重构一下数据管线");
      await turn("先拆读取层");
      for (let i = 0; i < 100 && !calls().length; i++) await delay(100);
      await delay(500);
      assert.equal(calls().length, 1);
      assert.equal((await c.snapshot(sid)).session.title, "重构一下数据管线");
      await turn("再拆写入层");
      for (let i = 0; i < 100 && (await c.snapshot(sid)).session.titleAuto; i++)
        await delay(100);
      assert.equal(calls().length, 2);
      assert.equal((await c.snapshot(sid)).session.title, "数据管线重构");
      await turn("第四轮");
      await delay(1500);
      assert.equal(calls().length, 2);
    });
  },
);
