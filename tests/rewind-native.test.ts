// 「回退」 natively: a live Claude Code process rewinds its own
// conversation in place (control rewind_conversation, same native id) and,
// when asked, the files its edit tools changed (rewind_files, dry run
// first); offline it falls back to the transcript copy. The notice says plainly
// what happened to the files. Real Runner + fake CLI (tests/fixtures/agent.cjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, until } from "./fixtures/scheduler-harness.ts";
import { rewindNotice } from "../packages/daisy/src/sessions/commands.ts";
import { rewindFilesFallback } from "../packages/daisy/src/turns/worker.ts";
import {
  AGENT_CAPABILITIES,
  capabilitiesFor,
  rewindRoute,
  askOnlyRoute,
} from "../packages/contracts/src/agent-capabilities.ts";
import {
  canRewindFiles,
  editBannerText,
  rewindPanelText,
} from "../packages/ui/src/rewind-copy.ts";
import { uiLang } from "./ui-pack.ts";

// ADR-159 §8: the UI speaks Chinese in these assertions.
uiLang("zh-CN");

const rewind = async (h: any, sid: string, args: any) => {
  const op = await h.c.operation(sid, "rewind", args);
  return until(
    () => h.c.operationStatus(sid, op.id),
    (r: any) => !!r.result,
    300,
  );
};

test("rewind (claude live): in place on the session's own process, files restored when asked, the process stays online", async () => {
  // The version the native rewind was measured on (review L4).
  process.env.DAISY_FIXTURE_CLI_VERSION = "2.1.316";
  const h: any = await setup();
  try {
    const s = await h.create("claude", "回退");
    const first = await h.c.send(s.id, "第一条", [], "rw-native-1");
    await h.settle(s.id);
    const second = await h.c.send(s.id, "第二条", [], "rw-native-2");
    const snap = await h.settle(s.id);
    const uuid = snap.items.find((i: any) => i.id === `user:${second.id}`)
      ?.native?.uuid;
    assert.ok(uuid, "the user item has its native uuid");
    const nativeBefore = h.ctx.store.session(s.id)!.nativeId;
    const pidOf = (via: string) =>
      h.lines(h.thread).filter((x: any) => x.via === via);
    const r = await rewind(h, s.id, {
      itemId: `user:${second.id}`,
      files: true,
    });
    assert.equal(r.result.inPlace, true);
    assert.equal(r.result.prefillText, "fixture prefill");
    assert.equal(r.result.files.reverted, true);
    assert.deepEqual(r.result.files.filesChanged, [
      "/fixture/a.txt",
      "/fixture/b.txt",
    ]);
    // Files first (dry run, then for real), then the conversation — all on
    // the one process that ran the turns (started with file checkpoints).
    const files = pidOf("rewind_files");
    assert.deepEqual(
      files.map((x: any) => x.dryRun),
      [true, undefined],
    );
    assert.ok(files.every((x: any) => x.uuid === uuid));
    assert.ok(files.every((x: any) => x.checkpoints === "true"));
    const conv = pidOf("rewind_conversation");
    assert.equal(conv.length, 1);
    assert.equal(conv[0].uuid, uuid);
    assert.equal(conv[0].pid, files[0].pid);
    // Same native session; the process was not closed for it.
    assert.equal(h.ctx.store.session(s.id)!.nativeId, nativeBefore);
    const after = await until(
      () => h.c.snapshot(s.id),
      (x: any) => !x.items.some((i: any) => i.id === `user:${second.id}`),
    );
    assert.ok(after.items.some((i: any) => i.id === `user:${first.id}`));
    const notice = after.items.find((i: any) =>
      /已回退 1 轮/.test(i.text || ""),
    );
    assert.match(notice.text, /在线回退，同一原生会话/);
    assert.match(notice.text, /文件已回退：2 个文件/);
    assert.notEqual(after.session.live?.online, false);
    // Without 「同时撤销文件」: the history only, the files are left alone.
    const third = await h.c.send(s.id, "第三条", [], "rw-native-3");
    await h.settle(s.id);
    const r2 = await rewind(h, s.id, { itemId: `user:${third.id}` });
    assert.equal(r2.result.inPlace, true);
    assert.equal(r2.result.files.reason, "not-asked");
    assert.equal(pidOf("rewind_files").length, 2);
    // Offline: the transcript copy (claude-session.ts; the fake CLI writes no
    // transcript, so here that copy fails) — no in-place request is sent.
    const fourth = await h.c.send(s.id, "第四条", [], "rw-native-4");
    await h.settle(s.id);
    await h.c.goOffline(s.id);
    await until(
      () => h.c.snapshot(s.id),
      (x: any) => x.session.live?.online === false,
    );
    const r3 = await rewind(h, s.id, {
      itemId: `user:${fourth.id}`,
      files: true,
    });
    assert.match(r3.result.error, /原生会话里找不到这条消息/);
    assert.equal(pidOf("rewind_conversation").length, 2);
    assert.equal(pidOf("rewind_files").length, 2);
  } finally {
    delete process.env.DAISY_FIXTURE_CLI_VERSION;
    await h.close();
  }
});

test("N-7: the /rewind panel's 「同时撤销文件」 (count + files) restores the edit-tool files like the edit banner", async () => {
  process.env.DAISY_FIXTURE_CLI_VERSION = "2.1.316";
  const h: any = await setup();
  try {
    const s = await h.create("claude", "回退面板");
    await h.c.send(s.id, "第一条", [], "rw-panel-1");
    await h.settle(s.id);
    const second = await h.c.send(s.id, "第二条", [], "rw-panel-2");
    const snap = await h.settle(s.id);
    const uuid = snap.items.find((i: any) => i.id === `user:${second.id}`)
      ?.native?.uuid;
    // What the panel sends: the number of turns, and files when toggled.
    const r = await rewind(h, s.id, { count: 1, files: true });
    assert.equal(r.result.inPlace, true);
    assert.equal(r.result.files.reverted, true);
    const files = h
      .lines(h.thread)
      .filter((x: any) => x.via === "rewind_files");
    assert.ok(files.length && files.every((x: any) => x.uuid === uuid));
  } finally {
    delete process.env.DAISY_FIXTURE_CLI_VERSION;
    await h.close();
  }
  // The panel says what it restores (edit-tool changes only).
  assert.match(rewindPanelText("claude", false), /文件改动不会撤销；要连文件一起恢复，打开「同时撤销文件」/);
  assert.match(rewindPanelText("claude", true), /用编辑工具改过的文件恢复到回退点之前；命令改的文件不在内/);
  assert.match(rewindPanelText("codex", true, "fallback"), /每轮的快照.*命令改的文件不在内/);
  // ADR-152: an older server's "harbor" reads the same.
  assert.equal(rewindPanelText("codex", true, "harbor"), rewindPanelText("codex", true, "fallback"));
  assert.match(rewindPanelText("codex", true), /不支持随回退恢复文件/);
});

test("rewind (claude live): background work or timers on the process → no in-place rewind (the copy closes it first)", async () => {
  process.env.DAISY_FIXTURE_CLI_VERSION = "2.1.316";
  // The fake's background Bash finishes only after a minute.
  process.env.DAISY_FIXTURE_WAKE_MS = "60000";
  const h: any = await setup();
  try {
    const s = await h.create("claude", "回退后台");
    const sent = await h.c.send(s.id, "BG_TEST", [], "rw-bg-0001");
    await h.settle(s.id);
    await until(
      () => h.c.snapshot(s.id),
      (x: any) => !!x.session.live?.pending?.length,
    );
    const r = await rewind(h, s.id, { itemId: `user:${sent.id}`, files: true });
    // The copy fails with the fake (no transcript); what matters: nothing
    // was asked of the live process, and it was taken offline first.
    assert.ok(r.result.error);
    assert.equal(
      h.lines(h.thread).filter((x: any) => /^rewind_/.test(x.via)).length,
      0,
    );
    const snap = await h.c.snapshot(s.id);
    assert.ok(
      snap.items.some((i: any) =>
        /AI 还有后台任务或定时器：先下线进程再回退/.test(i.name || ""),
      ),
    );
  } finally {
    delete process.env.DAISY_FIXTURE_CLI_VERSION;
    delete process.env.DAISY_FIXTURE_WAKE_MS;
    await h.close();
  }
});

test("rewind (claude): below the measured CLI version no in-place rewind is tried", async () => {
  const h: any = await setup();
  try {
    const s = await h.create("claude", "回退旧版");
    await h.c.send(s.id, "第一条", [], "rw-old-0001");
    await h.settle(s.id);
    const second = await h.c.send(s.id, "第二条", [], "rw-old-0002");
    await h.settle(s.id);
    // P4-11 (C-3): files are not declared below the measured version —
    // refused up front (never a partial rewind), history alone still goes.
    await assert.rejects(
      h.c.operation(s.id, "rewind", {
        itemId: `user:${second.id}`,
        files: true,
      }),
      (e: any) =>
        e.code === "capability_unsupported" &&
        /不支持「回退时同时撤销文件」/.test(e.message),
    );
    await rewind(h, s.id, { itemId: `user:${second.id}` });
    assert.equal(
      h.lines(h.thread).filter((x: any) => /^rewind_/.test(x.via)).length,
      0,
    );
  } finally {
    await h.close();
  }
});

test("rewindFilesFallback: a copied conversation reports why files stayed", () => {
  const job = (agent: string, files?: boolean) =>
    ({
      session: { agent },
      operation: { name: "rewind", args: { files } },
    }) as any;
  assert.deepEqual(rewindFilesFallback(job("claude"), null), {
    reverted: false,
    reason: "not-asked",
  });
  assert.equal(
    rewindFilesFallback(job("claude", true), null).reason,
    "offline",
  );
  assert.equal(
    rewindFilesFallback(job("codex", true), null).reason,
    "unsupported",
  );
  assert.equal(
    rewindFilesFallback(job("claude", true), null, true).reason,
    "background",
  );
  // An in-place attempt the CLI refused: what it did to the files stands.
  const tried = {
    sessionId: "x",
    inPlace: false,
    files: { reverted: true, filesChanged: ["/a"] },
  };
  assert.deepEqual(
    rewindFilesFallback(job("claude", true), tried),
    tried.files,
  );
});

test("rewindNotice: what happened to the files, said plainly per agent", () => {
  // Codex's files are Daisy's now — not asked is just 「文件未回退」;
  // an older Runner's `unsupported` still says Codex cannot.
  assert.match(
    rewindNotice(
      2,
      { files: { reverted: false, reason: "not-asked" } },
      "codex",
    ),
    /已回退 2 轮对话。文件未回退；/,
  );
  assert.match(
    rewindNotice(
      2,
      { files: { reverted: false, reason: "unsupported" } },
      "codex",
    ),
    /已回退 2 轮对话。文件未回退（Codex 不支持撤销文件改动）/,
  );
  // P4-10: the name from the ACP table (Kimi Code).
  assert.match(rewindNotice(1, { completed: true }, "kimi"), /Kimi Code 不支持/);
  assert.match(
    rewindNotice(
      1,
      { files: { reverted: false, reason: "background" } },
      "claude",
    ),
    /后台任务或定时器/,
  );
  assert.match(
    rewindNotice(
      1,
      { inPlace: true, files: { reverted: false, reason: "nothing" } },
      "claude",
    ),
    /在线回退.*这之后 AI 没有用编辑工具改过文件/,
  );
  assert.match(
    rewindNotice(
      1,
      {
        inPlace: true,
        files: { reverted: false, reason: "File rewinding is not enabled." },
      },
      "claude",
    ),
    /文件未回退（File rewinding is not enabled\.）/,
  );
  assert.match(rewindNotice(3, {}, "claude"), /^已回退 3 轮对话。文件未回退；/);
});

test("capabilities: askOnly / rewind per agent, below the measured versions the sidecar fork / transcript copy hold", () => {
  assert.deepEqual(AGENT_CAPABILITIES.claude.askOnly, {
    sideQuestion: "native",
    fork: "fallback",
    deadlineMs: 660_000,
  });
  assert.deepEqual(AGENT_CAPABILITIES.codex.askOnly, {
    sideQuestion: "none",
    fork: "native",
  });
  assert.equal(AGENT_CAPABILITIES.kimi.askOnly!.fork, "none");
  // Codex's files by Daisy's own checkpoints.
  assert.deepEqual(AGENT_CAPABILITIES.codex.rewind, {
    history: "native",
    files: "fallback",
  });
  const old = capabilitiesFor("claude", "2.1.300 (Claude Code)");
  assert.equal(old.askOnly!.sideQuestion, "none");
  assert.deepEqual(old.rewind, { history: "fallback", files: "none" });
  const oldCodex = capabilitiesFor("codex", "codex-cli 0.150.0");
  assert.equal(oldCodex.askOnly!.fork, "fallback");
  const now = capabilitiesFor("claude", "2.1.316 (Claude Code)");
  assert.equal(now.askOnly!.sideQuestion, "native");
  // Routes read from a node's report; an older Runner reports nothing.
  const caps = { agentFeatures: { claude: now } };
  assert.equal(askOnlyRoute(caps, "claude")!.sideQuestion, "native");
  assert.equal(rewindRoute(caps, "claude")!.files, "native");
  assert.equal(askOnlyRoute({}, "claude"), null);
  assert.equal(rewindRoute({ agentFeatures: {} }, "codex"), null);
});

test("edit banner: the files toggle only for Claude Code; the wording follows it", () => {
  assert.equal(canRewindFiles("claude"), true);
  assert.equal(canRewindFiles("codex"), false);
  assert.match(editBannerText("claude", false), /文件改动不会撤销/);
  assert.match(editBannerText("claude", true), /AI 用编辑工具改过的文件也恢复/);
  assert.match(editBannerText("codex", true), /文件改动不会撤销/);
});
