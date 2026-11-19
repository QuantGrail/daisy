// one AI title per session, the owner's rename always wins, kept
// in sync with the native session. Claude Code ≥ 2.1.316 names it in its own
// live process (`generate_session_title {persist:true}` → native ai-title)
// and reports every rename (`system/session_title_changed`); Codex never
// names a thread itself — Daisy's title goes out with `thread/name/set`,
// a rename there comes back from `thread.name` / `thread/name/updated`.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  AGENT_CAPABILITIES,
  capabilitiesFor,
  titleRoute,
} from "../packages/contracts/src/agent-capabilities.ts";
import {
  nativeTitle,
  sessionTitleDescription,
  sessionTitlePrompt,
} from "../packages/contracts/src/title.ts";
import { claudeAgent } from "../packages/daisy/src/harness/claude.ts";
import { codexAgent } from "../packages/daisy/src/harness/codex.ts";
import {
  noHooks,
  setLiveSettings,
  type LiveHooks,
  type NativeRenameAnswer,
  type Runtime,
} from "../packages/daisy/src/harness/shared.ts";
import { setTitleRunner, suggestTitle } from "../packages/daisy/src/turns/title.ts";
import { runOperation } from "../packages/daisy/src/turns/operations.ts";
import { forkTitle } from "../packages/contracts/src/title.ts";
import { mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { createApp } from "../packages/daisy/src/app.ts";
import { id } from "../packages/daisy/src/store/index.ts";
import { runNode, type NodeConfig } from "../packages/daisy/src/turns/worker.ts";
import { DaisyClient } from "../packages/client/src/index.ts";
import type { Snapshot } from "../packages/contracts/src/index.ts";
import { runnerConfig } from "./fixtures/runner-calls.ts";
import { runnerHeaders, runnerInject } from "./fixtures/runner-calls.ts";
import { OWNER_ID } from "../packages/daisy/src/access/owner.ts";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ENV = [
  "DAISY_CLAUDE_BIN",
  "DAISY_CODEX_BIN",
  "DAISY_FIXTURE_RECORD",
  "DAISY_FIXTURE_NATIVE_NAME",
  "DAISY_FIXTURE_NATIVE_TITLE",
  "DAISY_FIXTURE_CLI_VERSION",
  "DAISY_FIXTURE_TITLES",
  "DAISY_FIXTURE_TITLE_LOG",
  "DAISY_TITLE_BUDGET_MS",
  "DAISY_FIXTURE_NAME_ECHO",
];
const dirs: string[] = [];
/** What the control plane answers a native rename (tests change it). */
let answer: (
  t: string,
) => NativeRenameAnswer | null | Promise<NativeRenameAnswer | null> = () => ({
  applied: true,
});
afterEach(() => {
  answer = () => ({ applied: true });
  for (const k of ENV) delete process.env[k];
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  setLiveSettings(null);
});
// Its realpath: Claude names a project folder after the physical cwd
// (macOS: /var → /private/var).
const tmp = () => {
  const d = realpathSync.native(mkdtempSync(join(tmpdir(), "title-sync-")));
  dirs.push(d);
  return d;
};
const lines = (file: string) =>
  existsSync(file)
    ? readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];

test("capabilities: title generate / sync per agent, gated on the measured CLI versions", () => {
  assert.deepEqual(capabilitiesFor("claude", "2.1.316 (Claude Code)").title, {
    generate: "native",
    sync: "native",
  });
  // Older Claude Code: Daisy names it; rename_session (long-standing) still goes out.
  assert.deepEqual(capabilitiesFor("claude", "2.1.200").title, {
    generate: "fallback",
    sync: "native",
  });
  assert.deepEqual(capabilitiesFor("claude", undefined).title, {
    generate: "fallback",
    sync: "native",
  });
  assert.deepEqual(capabilitiesFor("codex", "codex-cli 0.157.1").title, {
    generate: "fallback",
    sync: "native",
  });
  assert.deepEqual(capabilitiesFor("codex", "0.150.0").title, {
    generate: "fallback",
    sync: "none",
  });
  assert.deepEqual(capabilitiesFor("kimi", "2.1.1").title, {
    generate: "none",
    sync: "none",
  });
  assert.deepEqual(
    titleRoute({ agentFeatures: AGENT_CAPABILITIES }, "codex"),
    AGENT_CAPABILITIES.codex.title,
  );
  assert.equal(titleRoute({}, "claude"), null);
  assert.equal(titleRoute(null, "claude"), null);
});

test("description: the two rounds only (the native namer brings its own rules); native names kept as written", () => {
  const rounds = [
    { user: "帮我看 GRM 回测", reply: "数据窗口变了" },
    { user: "按新窗口重跑", reply: "夏普 1.8" },
    { user: "第三轮", reply: "不该出现" },
  ];
  const d = sessionTitleDescription(rounds);
  assert.match(
    d,
    /^<round n="1">[\s\S]*GRM 回测[\s\S]*<round n="2">[\s\S]*夏普 1\.8[\s\S]*<\/round>$/,
  );
  assert.doesNotMatch(d, /第三轮|要求|示例/);
  // Daisy's own prompt embeds exactly the same material.
  assert.ok(sessionTitlePrompt(rounds).includes(d));
  assert.equal(
    nativeTitle("  「我的」\u0007名字\n二行 "),
    "「我的」 名字 二行",
  );
  assert.equal(nativeTitle(42), "");
  assert.equal([...nativeTitle("长".repeat(300))].length, 200);
});

test("runner: the native namer first, Daisy's CLI call only when it cannot", async () => {
  const job: any = {
    session: { id: "s-native", agent: "claude" },
    profile: { model: "" },
  };
  const cli: string[] = [];
  setTitleRunner(async (_bin, args) => {
    cli.push(args[1]);
    return "CLI 标题";
  });
  try {
    const got: string[] = [];
    const asked: string[] = [];
    await suggestTitle(
      job,
      { prompt: "P", description: "D" },
      async (t) => got.push(t),
      async (d) => {
        asked.push(d);
        return "「原生标题」";
      },
    );
    assert.deepEqual(asked, ["D"]);
    assert.deepEqual(got, ["原生标题"]);
    assert.deepEqual(cli, []);
    // No answer / an error: the CLI call, once.
    await suggestTitle(
      job,
      { prompt: "P", description: "D" },
      async (t) => got.push(t),
      async () => null,
    );
    await suggestTitle(
      job,
      { prompt: "P", description: "D" },
      async (t) => got.push(t),
      async () => {
        throw Error("API error");
      },
    );
    // An older control plane (no description): straight to the CLI.
    await suggestTitle(
      job,
      { prompt: "P" },
      async (t) => got.push(t),
      async () => "不该用",
    );
    assert.deepEqual(got, ["原生标题", "CLI 标题", "CLI 标题", "CLI 标题"]);
    assert.deepEqual(cli, ["P", "P", "P"]);
  } finally {
    setTitleRunner();
  }
});

// ---- Claude adapter against the fake CLI --------------------------------

const claudeJob = (
  jid: string,
  title: string,
  stage?: "final" | "manual",
  text = "hello",
) =>
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
      title,
      titleAuto: !stage,
      ...(stage ? { titleStage: stage } : {}),
    },
    profile: {
      id: "p",
      authMode: "apiKey",
      apiKey: "x",
      permissionMode: "manual",
    },
    workspace: { path: tmpdir() },
  }) as any;
const runtime = (j: any): Runtime =>
  ({
    job: j,
    cwd: tmpdir(),
    prompt: j.text,
    files: [],
    signal: new AbortController().signal,
    emit: () => {},
    flush: async () => {},
    approve: async () => ({ optionId: "allow" }),
    onInput: () => {},
  }) as any;
async function withClaude(
  env: Record<string, string>,
  first: any,
  fn: (x: {
    a: ReturnType<typeof claudeAgent>;
    reports: [string, string][];
    record: () => any[];
  }) => Promise<void>,
) {
  const dir = tmp();
  const file = join(dir, "record.jsonl");
  Object.assign(process.env, {
    DAISY_CLAUDE_BIN: resolve("tests/fixtures/agent.cjs"),
    DAISY_FIXTURE_RECORD: file,
    ...env,
  });
  const reports: [string, string][] = [];
  const hooks: LiveHooks = {
    ...noHooks,
    title: async (t, base) => {
      reports.push([t, base]);
      return answer(t);
    },
  };
  const a = claudeAgent(first, tmpdir(), hooks, true);
  try {
    await fn({ a, reports, record: () => lines(file) });
  } finally {
    a.stop();
    await a.stopped?.();
  }
}
const renames = (r: any[]) =>
  r.filter((x) => x.via === "rename_session").map((x) => x.title);

test("claude: a name the native session already has comes to Daisy as the owner's; Daisy's own echo does not", async () => {
  const first = claudeJob("j1", "第一句占位");
  await withClaude(
    { DAISY_FIXTURE_NATIVE_NAME: "TUI里改的名" },
    first,
    async ({ a, reports, record }) => {
      await a.turn(runtime(first));
      assert.deepEqual(reports, [["TUI里改的名", "第一句占位"]]);
      // Daisy now has it as the owner's title: not pushed back.
      await a.turn(runtime(claudeJob("j2", "TUI里改的名", "manual")));
      assert.deepEqual(renames(record()), []);
      // Renamed in Daisy: pushed; its session_title_changed echo is not a report.
      await a.turn(runtime(claudeJob("j3", "Daisy 改的名", "manual")));
      assert.deepEqual(renames(record()), ["Daisy 改的名"]);
      // Renamed in the CLI later: reported against Daisy's current title.
      // The control plane's answer is still on its way (released below).
      let release!: (x: NativeRenameAnswer) => void;
      answer = () => new Promise((r) => (release = r));
      await a.turn(
        runtime(
          claudeJob("j4", "Daisy 改的名", "manual", "NATIVE_RENAME:CLI新名"),
        ),
      );
      await delay(50);
      assert.deepEqual(reports, [
        ["TUI里改的名", "第一句占位"],
        ["CLI新名", "Daisy 改的名"],
      ]);
      // While it is being reported, a job still carrying Daisy's older
      // title does not undo that rename; once answered, Daisy's newer
      // title goes out.
      await a.turn(runtime(claudeJob("j5", "Daisy 改的名", "manual")));
      assert.deepEqual(renames(record()), ["Daisy 改的名"]);
      release({ applied: false, title: "Daisy 更新的名" });
      await delay(10);
      await a.turn(runtime(claudeJob("j6", "Daisy 更新的名", "manual")));
      assert.deepEqual(renames(record()), ["Daisy 改的名", "Daisy 更新的名"]);
    },
  );
});

test("claude: at startup Daisy's own manual title beats the native name and is pushed", async () => {
  const first = claudeJob("j1", "我在 Daisy 起的名", "manual");
  await withClaude(
    { DAISY_FIXTURE_NATIVE_NAME: "旧的原生名" },
    first,
    async ({ a, reports, record }) => {
      await a.turn(runtime(first));
      assert.deepEqual(reports, []);
      assert.deepEqual(renames(record()), ["我在 Daisy 起的名"]);
    },
  );
  // Already the same: nothing to push, nothing to report.
  const same = claudeJob("j1", "同名", "manual");
  await withClaude(
    { DAISY_FIXTURE_NATIVE_NAME: "同名" },
    same,
    async ({ a, reports, record }) => {
      await a.turn(runtime(same));
      assert.deepEqual(reports, []);
      assert.deepEqual(renames(record()), []);
    },
  );
});

test("claude: the AI title comes from the live process (generate_session_title, persisted as the native ai-title)", async () => {
  const first = claudeJob("j1", "占位");
  await withClaude(
    { DAISY_FIXTURE_NATIVE_TITLE: "GRM 回测窗口排查" },
    first,
    async ({ a, record }) => {
      // Not started yet: cannot.
      assert.equal(await a.generateTitle!("D", 5000), null);
      await a.turn(runtime(first));
      assert.equal(
        await a.generateTitle!('<round n="1">…</round>', 5000),
        "GRM 回测窗口排查",
      );
      const [g] = record().filter((x) => x.via === "generate_session_title");
      assert.deepEqual(g, {
        via: "generate_session_title",
        description: '<round n="1">…</round>',
        persist: true,
      });
      // The AI title is never sent as the owner's rename.
      await a.turn(runtime(claudeJob("j2", "GRM 回测窗口排查", "final")));
      assert.deepEqual(renames(record()), []);
    },
  );
  await withClaude(
    { DAISY_FIXTURE_NATIVE_TITLE: "fail" },
    first,
    async ({ a }) => {
      await a.turn(runtime(first));
      await assert.rejects(a.generateTitle!("D", 5000));
    },
  );
});

// ---- Codex adapter against the fake app-server ---------------------------

const codexJob = (
  jid: string,
  title: string,
  stage?: "final" | "manual",
  nativeId: string | null = null,
) =>
  ({
    id: jid,
    text: "hi",
    session: {
      id: "s1",
      agent: "codex",
      nativeId,
      title,
      titleAuto: !stage,
      ...(stage ? { titleStage: stage } : {}),
    },
    profile: { id: "p1", label: "Codex", authMode: "subscription" },
    attachments: [],
  }) as any;
async function withCodex(
  env: Record<string, string>,
  first: any,
  fn: (x: {
    a: ReturnType<typeof codexAgent>;
    reports: [string, string][];
    sets: () => string[];
    turn: (j: any, prompt?: string) => Promise<unknown>;
  }) => Promise<void>,
  version = "0.157.1",
) {
  const dir = tmp();
  const file = join(dir, "record.jsonl");
  Object.assign(process.env, {
    DAISY_CODEX_BIN: resolve("tests/fixtures/agent.cjs"),
    DAISY_FIXTURE_RECORD: file,
    ...env,
  });
  setLiveSettings({ codex: capabilitiesFor("codex", version) });
  const reports: [string, string][] = [];
  const a = codexAgent(
    first,
    process.cwd(),
    {
      ...noHooks,
      title: async (t, base) => {
        reports.push([t, base]);
        return answer(t);
      },
    },
    true,
  );
  const turn = (j: any, prompt = "hi") =>
    a.turn({
      ...runtime(j),
      cwd: process.cwd(),
      prompt,
      approve: async () => ({ optionId: "accept" }),
    } as any);
  try {
    await fn({
      a,
      reports,
      sets: () =>
        lines(file)
          .filter((x) => x.via === "thread/name/set")
          .map((x) => x.name),
      turn,
    });
  } finally {
    a.stop();
    await a.stopped?.();
  }
}

test("codex: Daisy's title (AI or owner's) goes to the thread; the placeholder does not; an applied AI title goes at once", async () => {
  const first = codexJob("j1", "第一句占位");
  await withCodex({}, first, async ({ a, reports, sets, turn }) => {
    await turn(first);
    assert.deepEqual(sets(), []);
    // The AI title Daisy just applied, without waiting for a turn.
    await a.pushTitle!("Codex 线程命名");
    assert.deepEqual(sets(), ["Codex 线程命名"]);
    // Its thread/name/updated echo is not a rename; the next turn has it already.
    await turn(codexJob("j2", "Codex 线程命名", "final"));
    assert.deepEqual(sets(), ["Codex 线程命名"]);
    await turn(codexJob("j3", "主人改的名", "manual"));
    assert.deepEqual(sets(), ["Codex 线程命名", "主人改的名"]);
    assert.deepEqual(reports, []);
    // Renamed in Codex (another client on this thread): the owner's, to Daisy.
    await turn(
      codexJob("j4", "主人改的名", "manual"),
      "NATIVE_RENAME:Codex里改的",
    );
    assert.deepEqual(reports, [["Codex里改的", "主人改的名"]]);
  });
});

test("codex: a resumed thread's own name — Daisy's manual title wins, otherwise it is the owner's rename", async () => {
  const manual = codexJob("j1", "Daisy 的名", "manual", "codex-native");
  await withCodex(
    { DAISY_FIXTURE_NATIVE_NAME: "TUI 的名" },
    manual,
    async ({ reports, sets, turn }) => {
      await turn(manual);
      assert.deepEqual(reports, []);
      assert.deepEqual(sets(), ["Daisy 的名"]);
    },
  );
  const ai = codexJob("j1", "AI 的名", "final", "codex-native");
  await withCodex(
    { DAISY_FIXTURE_NATIVE_NAME: "TUI 的名" },
    ai,
    async ({ reports, sets, turn }) => {
      await turn(ai);
      assert.deepEqual(reports, [["TUI 的名", "AI 的名"]]);
      assert.deepEqual(sets(), []);
    },
  );
});

test("codex: below the measured version names stay Daisy's only", async () => {
  const first = codexJob("j1", "主人改的名", "manual", "codex-native");
  await withCodex(
    { DAISY_FIXTURE_NATIVE_NAME: "TUI 的名" },
    first,
    async ({ a, reports, sets, turn }) => {
      await turn(first);
      await a.pushTitle!("AI");
      assert.deepEqual(sets(), []);
      assert.deepEqual(reports, []);
    },
    "0.150.0",
  );
});

// ---- Control plane --------------------------------------------------------

async function plane(capabilities: any) {
  const dir = tmp();
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
  await call("POST", "/api/runner/sync", { capabilities }, nh);
  const cat = (await call("GET", "/api/catalog")).json();
  const create = async (agent = "claude") =>
    (
      await call("POST", "/api/sessions", {
        agent,
        workspaceId: cat.workspaces[0].id,
        profileId: cat.profiles.find((p: any) => p.agent === agent).id,
      })
    ).json();
  let n = 0;
  const round = async (sid: string, text: string) => {
    await call("POST", `/api/sessions/${sid}/messages`, {
      text,
      requestId: `title-sync-${++n}`,
    });
    const job = (await call("POST", "/api/runner/claim", {}, nh)).json().job;
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
              text: `答：${text}`,
              createdAt: Date.now(),
            },
          },
        ],
      },
      jh,
    );
    return (
      await call(
        "POST",
        `/api/runner/jobs/${job.id}/complete`,
        { status: "idle" },
        jh,
      )
    ).json();
  };
  const title = (sid: string, body: any) =>
    call("POST", `/api/runner/sessions/${sid}/title`, body, nh).then((r) =>
      r.json(),
    );
  const snap = async (sid: string) =>
    (await call("GET", `/api/sessions/${sid}`)).json().session;
  return { app, call, create, round, title, snap };
}

test("server: the title request carries the rounds for a native namer; a node saying generate none is not asked", async () => {
  const t = await plane({
    sessionTitles: { version: 2 },
    agentFeatures: {
      claude: capabilitiesFor("claude", "2.1.316"),
      codex: {
        ...capabilitiesFor("codex", "0.157.1"),
        title: { generate: "none", sync: "none" },
      },
    },
  });
  try {
    const s = await t.create();
    await t.round(s.id, "帮我看 GRM 回测");
    const req = (await t.round(s.id, "按新窗口重跑")).titleRequest;
    assert.match(
      req.description,
      /^<round n="1">[\s\S]*GRM 回测[\s\S]*按新窗口重跑/,
    );
    assert.ok(req.prompt.includes(req.description));
    const c = await t.create("codex");
    await t.round(c.id, "一");
    assert.equal((await t.round(c.id, "二")).titleRequest, undefined);
  } finally {
    await t.app.close();
  }
});

test("server: a native rename is the owner's — unless Daisy's own title changed since the Runner saw it", async () => {
  const t = await plane({ sessionTitles: { version: 2 } });
  try {
    const s = await t.create();
    await t.round(s.id, "第一句");
    // Over the placeholder: applied as the owner's.
    assert.deepEqual(
      await t.title(s.id, {
        title: " TUI 名\n",
        source: "native",
        base: "第一句",
      }),
      {
        ok: true,
        applied: true,
        title: "TUI 名",
      },
    );
    let x = await t.snap(s.id);
    assert.equal(x.titleStage, "manual");
    assert.equal(x.titleAuto, false);
    // The AI title (round 2) never replaces it, nor is it asked for.
    assert.equal((await t.round(s.id, "二")).titleRequest, undefined);
    assert.equal(
      (await t.title(s.id, { title: "AI 名", stage: "final" })).applied,
      false,
    );
    // Renamed in Daisy meanwhile: a native rename against the old title loses.
    await t.call("PATCH", `/api/sessions/${s.id}`, { title: "Daisy 名" });
    const lost = await t.title(s.id, {
      title: "又一个 TUI 名",
      source: "native",
      base: "TUI 名",
    });
    assert.equal(lost.applied, false);
    assert.equal(lost.title, "Daisy 名");
    // Against the current one it wins; the same name again is nothing.
    assert.equal(
      (
        await t.title(s.id, {
          title: "最新 TUI 名",
          source: "native",
          base: "Daisy 名",
        })
      ).applied,
      true,
    );
    assert.equal(
      (
        await t.title(s.id, {
          title: "最新 TUI 名",
          source: "native",
          base: "x",
        })
      ).applied,
      false,
    );
    x = await t.snap(s.id);
    assert.equal(x.title, "最新 TUI 名");
    // Over the AI title: the owner's.
    const b = await t.create();
    await t.round(b.id, "一");
    await t.round(b.id, "二");
    await t.title(b.id, { title: "AI 名", stage: "final" });
    assert.equal(
      (
        await t.title(b.id, {
          title: "CLI 名",
          source: "native",
          base: "AI 名",
        })
      ).applied,
      true,
    );
    assert.equal((await t.snap(b.id)).titleStage, "manual");
  } finally {
    await t.app.close();
  }
});

// ---- Real Runner + fake Claude Code 2.1.316 -------------------------------

test(
  "runner + fake Claude 2.1.316: the round-2 title is made by the live process — no extra CLI process — and a CLI rename comes back",
  { timeout: 60000 },
  async () => {
    const dir = tmp();
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
    config.identityRoot ??= join(dir, "runner-state-root");
    const record = join(dir, "record.jsonl"),
      log = join(dir, "titles.jsonl");
    Object.assign(process.env, {
      DAISY_CLAUDE_BIN: resolve("tests/fixtures/agent.cjs"),
      DAISY_FIXTURE_CLI_VERSION: "2.1.316",
      DAISY_FIXTURE_NATIVE_TITLE: "GRM 回测窗口排查",
      DAISY_FIXTURE_RECORD: record,
      DAISY_FIXTURE_TITLES: "不该用的 CLI 标题",
      DAISY_FIXTURE_TITLE_LOG: log,
    });
    const controller = new AbortController();
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
      await turn("帮我看看 GRM 回测为什么变了");
      await turn("按 8 月新窗口重跑");
      const named = await until((x) => x.session.titleStage === "final");
      assert.equal(named.session.title, "GRM 回测窗口排查");
      const gen = lines(record).filter(
        (x) => x.via === "generate_session_title",
      );
      assert.equal(gen.length, 1);
      assert.equal(gen[0].persist, true);
      assert.ok(
        gen[0].description.includes("GRM 回测为什么变了") &&
          gen[0].description.includes("按 8 月新窗口重跑"),
      );
      assert.deepEqual(lines(log), [], "no separate title CLI process");
      // The owner renames the session in Claude Code: Daisy follows.
      await turn("NATIVE_RENAME:CLI里改的名");
      const renamed = await until((x) => x.session.title === "CLI里改的名");
      assert.equal(renamed.session.titleStage, "manual");
      // …and Daisy's own rename goes back to the native session.
      await c.updateSession(s.id, { title: "Daisy 里改的名" });
      await turn("再来一轮");
      assert.deepEqual(
        lines(record)
          .filter((x) => x.via === "rename_session")
          .map((x) => x.title),
        ["Daisy 里改的名"],
      );
      assert.equal((await c.snapshot(s.id)).session.title, "Daisy 里改的名");
    } finally {
      controller.abort();
      await worker.catch(() => {});
      await ctx.app.close();
    }
  },
);

// ---- Review follow-ups (77d8a3d) -------------------------------------------

test("review H1: a Claude copy carries Daisy's title or a marker — the marker is never the owner's rename, nor the AI title", async () => {
  assert.equal(
    forkTitle({ title: "AI 名", titleStage: "final" }, false),
    "AI 名",
  );
  assert.equal(
    forkTitle({ title: " 我的\n名 ", titleStage: "manual" }, true),
    "我的 名",
  );
  assert.equal(forkTitle({ title: "首句占位" }, false), "Daisy fork");
  assert.equal(forkTitle({ title: "首句占位" }, true), "Daisy rewind");
  // A resumed copy announces the marker: not reported; the namer, which
  // answers that custom title with persist:true, is asked again without.
  const first = claudeJob("j1", "首句占位");
  await withClaude(
    {
      DAISY_FIXTURE_NATIVE_NAME: "Daisy fork",
      DAISY_FIXTURE_NATIVE_TITLE: "真正的标题",
    },
    first,
    async ({ a, reports, record }) => {
      await a.turn(runtime(first));
      assert.deepEqual(reports, []);
      assert.equal(await a.generateTitle!("D", 5000), "真正的标题");
      assert.deepEqual(
        record()
          .filter((x) => x.via === "generate_session_title")
          .map((x) => x.persist),
        [true, false],
      );
    },
  );
  // Over the marker, Daisy's own manual title is pushed.
  const manual = claudeJob("j1", "主人的名", "manual");
  await withClaude(
    { DAISY_FIXTURE_NATIVE_NAME: "Daisy rewind" },
    manual,
    async ({ a, reports, record }) => {
      await a.turn(runtime(manual));
      assert.deepEqual(reports, []);
      assert.deepEqual(renames(record()), ["主人的名"]);
    },
  );
});

test("review H1: /fork and an offline 「回退」 write Daisy's title (or the marker) into the copy; a Codex copy is named after the new session", async () => {
  const dir = tmp();
  const ws = join(dir, "ws"),
    cfg = join(dir, "cfg");
  const proj = join(cfg, "projects", ws.replace(/[^A-Za-z0-9]/g, "-"));
  mkdirSync(proj, { recursive: true });
  mkdirSync(ws);
  const sid = "11111111-2222-3333-4444-555555555555";
  const entry = (
    uuid: string,
    parent: string | null,
    role: string,
    text: string,
    i: number,
  ) =>
    JSON.stringify({
      type: role,
      uuid,
      parentUuid: parent,
      sessionId: sid,
      cwd: ws,
      timestamp: `2026-11-08T00:00:0${i}.000Z`,
      message: {
        role,
        content: role === "user" ? text : [{ type: "text", text }],
      },
    });
  writeFileSync(
    join(proj, `${sid}.jsonl`),
    [
      entry("u1", null, "user", "一", 0),
      entry("a1", "u1", "assistant", "答一", 1),
      entry("u2", "a1", "user", "二", 2),
      entry("a2", "u2", "assistant", "答二", 3),
    ].join("\n") + "\n",
  );
  const op = (name: string, session: any, args: any = {}) =>
    runOperation({
      ...runtime({
        id: "op",
        text: "",
        session: { id: "s1", agent: "claude", nativeId: sid, ...session },
        profile: { id: "p", configDir: cfg },
        operation: { name, args },
      }),
      cwd: ws,
    } as any);
  const titleOf = (native: string) =>
    readFileSync(join(proj, `${native}.jsonl`), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
      .filter((x) => x.type === "custom-title")
      .map((x) => x.customTitle);
  const fork = await op(
    "fork",
    { title: "AI 名 · 分支", titleStage: "final" },
    { sourceNativeId: sid },
  );
  assert.deepEqual(titleOf(fork.sessionId), ["AI 名 · 分支"]);
  const back = await op("rewind", { title: "首句占位" }, { count: 1 });
  assert.deepEqual(titleOf(back.sessionId), ["Daisy rewind"]);
  assert.equal(readdirSync(proj).length, 3);

  // Codex: the forked thread is named after the new session.
  const rec = join(dir, "codex.jsonl");
  Object.assign(process.env, {
    DAISY_CODEX_BIN: resolve("tests/fixtures/agent.cjs"),
    DAISY_FIXTURE_RECORD: rec,
  });
  setLiveSettings({ codex: capabilitiesFor("codex", "0.157.1") });
  const r = await runOperation({
    ...runtime({
      id: "op",
      text: "",
      session: {
        id: "s2",
        agent: "codex",
        nativeId: "codex-native",
        title: "AI 名 · 分支",
        titleStage: "final",
      },
      profile: { id: "p1", authMode: "subscription" },
      operation: { name: "fork", args: { sourceNativeId: "codex-native" } },
    }),
    cwd: process.cwd(),
  } as any);
  assert.deepEqual(
    lines(rec)
      .filter((x) => x.via === "thread/name/set")
      .map((x) => [x.threadId, x.name]),
    [[r.nativeId, "AI 名 · 分支"]],
  );
});

test("review M2: once Daisy answers the native rename, its title flows again — renaming back is pushed; a kept / unreported rename lets Daisy's go out", async () => {
  const first = claudeJob("j1", "A", "manual");
  await withClaude({}, first, async ({ a, reports, record }) => {
    await a.turn(runtime(first));
    await a.turn(runtime(claudeJob("j2", "A", "manual", "NATIVE_RENAME:B")));
    await delay(30);
    assert.deepEqual(reports, [["B", "A"]]);
    // Daisy took it: B is not pushed back; renaming back to A in Daisy is.
    await a.turn(runtime(claudeJob("j3", "B", "manual")));
    await a.turn(runtime(claudeJob("j4", "A", "manual")));
    assert.deepEqual(renames(record()), ["A", "A"]);
    // Daisy kept its own (renamed meanwhile): its title goes out next turn.
    answer = () => ({ applied: false, title: "A" });
    await a.turn(runtime(claudeJob("j5", "A", "manual", "NATIVE_RENAME:C")));
    await delay(30);
    await a.turn(runtime(claudeJob("j6", "A", "manual")));
    assert.deepEqual(renames(record()), ["A", "A", "A"]);
    // Not reported at all (control plane unreachable): the same.
    answer = () => null;
    await a.turn(runtime(claudeJob("j7", "A", "manual", "NATIVE_RENAME:D")));
    await delay(30);
    await a.turn(runtime(claudeJob("j8", "A", "manual")));
    assert.deepEqual(renames(record()), ["A", "A", "A", "A"]);
  });
  const c = codexJob("j1", "A", "manual");
  await withCodex({}, c, async ({ reports, sets, turn }) => {
    await turn(c);
    await turn(codexJob("j2", "A", "manual"), "NATIVE_RENAME:B");
    await delay(30);
    assert.deepEqual(reports, [["B", "A"]]);
    await turn(codexJob("j3", "B", "manual"));
    await turn(codexJob("j4", "A", "manual"));
    assert.deepEqual(sets(), ["A", "A"]);
  });
});

test("review L4: a late AI title never goes over the owner's, and Daisy's own names are never reported back", async () => {
  const c = codexJob("j1", "占位");
  await withCodex(
    { DAISY_FIXTURE_NAME_ECHO: "late" },
    c,
    async ({ a, reports, sets, turn }) => {
      await turn(c);
      await a.pushTitle!("AI名");
      await turn(codexJob("j2", "主人的名", "manual"));
      // The AI title arriving after the owner's: dropped.
      await a.pushTitle!("迟到的 AI 名");
      assert.deepEqual(sets(), ["AI名", "主人的名"]);
      // Codex repeating a name Daisy set (a late echo): not a rename.
      await turn(codexJob("j3", "主人的名", "manual"), "NATIVE_RENAME:AI名");
      await turn(
        codexJob("j4", "主人的名", "manual"),
        "NATIVE_RENAME:主人的名",
      );
      assert.deepEqual(reports, []);
      // Re-review L-b: an echo is consumed once — the owner renaming back to
      // a name Daisy once set is a rename.
      await turn(codexJob("j5", "主人的名", "manual"), "NATIVE_RENAME:AI名");
      await delay(20);
      assert.deepEqual(reports, [["AI名", "主人的名"]]);
    },
  );
});

test("review L5: names compare as the native side keeps them (one line, trimmed)", async () => {
  const first = claudeJob("j1", "两行\n标题 ", "manual");
  await withClaude({}, first, async ({ a, reports, record }) => {
    await a.turn(runtime(first));
    await a.turn(runtime(claudeJob("j2", "两行\n标题 ", "manual")));
    assert.deepEqual(renames(record()), ["两行 标题"]);
    assert.deepEqual(reports, []);
  });
});

test("review L6 / H1 / L5: the control plane refuses a native rename of an archived session, Daisy's copy marker, and a name equal once normalised", async () => {
  const t = await plane({ sessionTitles: { version: 2 } });
  try {
    const s = await t.create();
    await t.round(s.id, "第一句");
    for (const name of ["Daisy fork", " Daisy rewind ", "Harbor fork", " Harbor rewind "])
      assert.equal(
        (await t.title(s.id, { title: name, source: "native", base: "第一句" }))
          .applied,
        false,
      );
    await t.call("PATCH", `/api/sessions/${s.id}`, { title: "两行\n标题" });
    assert.equal(
      (
        await t.title(s.id, {
          title: "两行 标题",
          source: "native",
          base: "两行 标题",
        })
      ).applied,
      false,
    );
    assert.equal((await t.snap(s.id)).title, "两行\n标题");
    // …while the Runner's normalised base still counts as Daisy's title.
    assert.equal(
      (
        await t.title(s.id, {
          title: "新名",
          source: "native",
          base: "两行 标题",
        })
      ).applied,
      true,
    );
    const b = await t.create();
    await t.round(b.id, "一");
    await t.call("PATCH", `/api/sessions/${b.id}`, { archived: true });
    assert.equal(
      (await t.title(b.id, { title: "TUI 名", source: "native", base: "一" }))
        .applied,
      false,
    );
  } finally {
    await t.app.close();
  }
});

test("review M3: native namer + CLI call stay within the attempt budget the control plane waits", async () => {
  const job: any = {
    session: { id: "s-budget", agent: "claude" },
    profile: { model: "" },
  };
  const seen: number[] = [];
  setTitleRunner(async (_b, _a, o) => {
    seen.push(o.timeoutMs);
    return "CLI 标题";
  });
  try {
    let nativeMs = 0;
    process.env.DAISY_TITLE_BUDGET_MS = "8000";
    const got: string[] = [];
    await suggestTitle(
      job,
      { prompt: "P", description: "D" },
      async (t) => got.push(t),
      async (_d, ms) => {
        nativeMs = ms;
        return null;
      },
    );
    assert.equal(nativeMs, 8000);
    assert.ok(seen[0] <= 8000 && seen[0] >= 5000, String(seen[0]));
    // No time left for the CLI: the attempt fails at once (retried next round).
    process.env.DAISY_TITLE_BUDGET_MS = "4000";
    await suggestTitle(
      job,
      { prompt: "P", description: "D" },
      async (t) => got.push(t),
      async () => null,
    );
    assert.deepEqual(got, ["CLI 标题", ""]);
    assert.equal(seen.length, 1);
  } finally {
    setTitleRunner();
  }
});

// ---- Re-review (8536362) ----------------------------------------------------

test("re-review M-a / L-a: a late answer never overwrites a newer Daisy title; renames while one is out are coalesced against what Daisy took", async () => {
  const first = claudeJob("j1", "旧", "manual");
  const pending: ((x: NativeRenameAnswer | null) => void)[] = [];
  answer = () => new Promise((r) => pending.push(r));
  await withClaude({}, first, async ({ a, reports, record }) => {
    await a.turn(runtime(first));
    // Owner renames to A natively; the report is slow.
    await a.turn(runtime(claudeJob("j2", "旧", "manual", "NATIVE_RENAME:A")));
    await delay(20);
    // Meanwhile Daisy's own rename B arrives with the next job and goes out.
    await a.turn(runtime(claudeJob("j3", "B", "manual")));
    assert.deepEqual(renames(record()), ["旧", "B"]);
    // A's late "applied" does not make Daisy's title A here…
    pending.shift()!({ applied: true });
    await delay(10);
    // …so a native rename C now is reported (against B), not dropped.
    answer = () => ({ applied: true });
    await a.turn(runtime(claudeJob("j4", "B", "manual", "NATIVE_RENAME:C")));
    await delay(20);
    assert.deepEqual(reports, [
      ["A", "旧"],
      ["C", "B"],
    ]);
    // Taken: C is not pushed back.
    await a.turn(runtime(claudeJob("j5", "C", "manual")));
    assert.deepEqual(renames(record()), ["旧", "B"]);
  });
  // Back-to-back renames: the second waits, then goes against the first.
  const second: ((x: NativeRenameAnswer | null) => void)[] = [];
  answer = () => new Promise((r) => second.push(r));
  const c = codexJob("j1", "旧", "manual");
  await withCodex({}, c, async ({ reports, turn }) => {
    await turn(c);
    await turn(codexJob("j2", "旧", "manual"), "NATIVE_RENAME:A1");
    await turn(codexJob("j3", "旧", "manual"), "NATIVE_RENAME:A2");
    await turn(codexJob("j4", "旧", "manual"), "NATIVE_RENAME:A3");
    await delay(20);
    assert.deepEqual(reports, [["A1", "旧"]]);
    second.shift()!({ applied: true });
    await delay(20);
    assert.deepEqual(reports, [
      ["A1", "旧"],
      ["A3", "A1"],
    ]);
  });
});

test("re-review L-c: over Daisy's copy marker the applied AI title goes out once, as Daisy's own (its echo is not a rename)", async () => {
  const first = claudeJob("j1", "首句占位");
  await withClaude(
    { DAISY_FIXTURE_NATIVE_NAME: "Daisy fork" },
    first,
    async ({ a, reports, record }) => {
      await a.turn(runtime(first));
      await a.pushTitle!("AI 起的名");
      assert.deepEqual(renames(record()), ["AI 起的名"]);
      await a.turn(runtime(claudeJob("j2", "AI 起的名", "final")));
      assert.deepEqual(renames(record()), ["AI 起的名"]);
      assert.deepEqual(reports, []);
    },
  );
  // Over the owner's native name (not taken by Daisy), the AI title is not pushed.
  answer = () => null;
  await withClaude(
    { DAISY_FIXTURE_NATIVE_NAME: "TUI 的名" },
    first,
    async ({ a, record }) => {
      await a.turn(runtime(first));
      await a.pushTitle!("AI 起的名");
      assert.deepEqual(renames(record()), []);
    },
  );
});

test("re-review L-d: an owner's native name Daisy missed is reported at round 2 instead of naming the session anew", async () => {
  // The adapters say which name that is.
  answer = () => null; // its own report failed
  const first = claudeJob("j1", "首句占位");
  await withClaude(
    { DAISY_FIXTURE_NATIVE_NAME: "TUI 的名" },
    first,
    async ({ a }) => {
      await a.turn(runtime(first));
      await delay(10);
      assert.equal(a.ownerName!(), "TUI 的名");
    },
  );
  await withClaude(
    { DAISY_FIXTURE_NATIVE_NAME: "Daisy fork" },
    first,
    async ({ a }) => {
      await a.turn(runtime(first));
      assert.equal(a.ownerName!(), null);
    },
  );
  const c = codexJob("j1", "首句占位", undefined, "codex-native");
  await withCodex(
    { DAISY_FIXTURE_NATIVE_NAME: "TUI 的名" },
    c,
    async ({ a, turn }) => {
      await turn(c);
      await delay(10);
      assert.equal(a.ownerName!(), "TUI 的名");
    },
  );
  // suggestTitle: taken → no naming at all; not taken / error → named.
  const job: any = {
    session: { id: "s-owner", agent: "claude" },
    profile: { model: "" },
  };
  const got: string[] = [];
  let named = 0;
  const native = async () => {
    named++;
    return "原生标题";
  };
  await suggestTitle(
    job,
    { prompt: "P", description: "D" },
    async (t) => got.push(t),
    native,
    async () => true,
  );
  assert.deepEqual([got, named], [[], 0]);
  await suggestTitle(
    job,
    { prompt: "P", description: "D" },
    async (t) => got.push(t),
    native,
    async () => false,
  );
  await suggestTitle(
    job,
    { prompt: "P", description: "D" },
    async (t) => got.push(t),
    native,
    async () => {
      throw Error("offline");
    },
  );
  assert.deepEqual([got, named], [["原生标题", "原生标题"], 2]);
});

test("re-review L-e: a Codex copy of a placeholder-titled session is named after it (never the source's name)", async () => {
  const rec = join(tmp(), "codex.jsonl");
  Object.assign(process.env, {
    DAISY_CODEX_BIN: resolve("tests/fixtures/agent.cjs"),
    DAISY_FIXTURE_RECORD: rec,
  });
  setLiveSettings({ codex: capabilitiesFor("codex", "0.157.1") });
  const r = await runOperation({
    ...runtime({
      id: "op",
      text: "",
      session: {
        id: "s2",
        agent: "codex",
        nativeId: "codex-native",
        title: "首句占位 · 分支",
      },
      profile: { id: "p1", authMode: "subscription" },
      operation: { name: "fork", args: { sourceNativeId: "codex-native" } },
    }),
    cwd: process.cwd(),
  } as any);
  assert.deepEqual(
    lines(rec)
      .filter((x) => x.via === "thread/name/set")
      .map((x) => [x.threadId, x.name]),
    [[r.nativeId, "首句占位 · 分支"]],
  );
  // That name back on resume is Daisy's own: no rename, no owner name.
  const c = codexJob("j1", "首句占位 · 分支", undefined, r.nativeId);
  await withCodex(
    { DAISY_FIXTURE_NATIVE_NAME: "首句占位 · 分支" },
    c,
    async ({ a, reports, turn }) => {
      await turn(c);
      assert.deepEqual(reports, []);
      assert.equal(a.ownerName!(), null);
    },
  );
});
