// 「回退」 with files for Codex: Codex has no file checkpoints
// (thread/revert rewinds the conversation only), so Daisy keeps its own
// per turn and restores what the AI's edit tool (fileChange) changed;
// commands' changes are named, not restored; a file changed after the
// AI's edit refuses the whole rewind. Real Runner + fake Codex
// (tests/fixtures/agent.cjs FX_* turns), and the module itself on a git
// workspace.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { setup, until } from "./fixtures/scheduler-harness.ts";
import {
  TurnCheckpoint,
  applyRewindFiles,
  blobId,
  canonical,
  configureFileCheckpoints,
  dropCheckpointsFrom,
  forbidden,
  planRewindFiles,
  sweep,
  workspacePath,
} from "../packages/daisy/src/turns/file-checkpoints.ts";
import { rewindNotice } from "../packages/daisy/src/sessions/commands.ts";
import { PRODUCT_NAME } from "../packages/contracts/src/names.ts";
import {
  AGENT_CAPABILITIES,
  capabilitiesFor,
  rewindFilesRoute,
} from "../packages/contracts/src/agent-capabilities.ts";
import {
  canRewindFiles,
  editBannerText,
} from "../packages/ui/src/rewind-copy.ts";
import { uiLang } from "./ui-pack.ts";

// ADR-159 §8: the UI speaks Chinese in these assertions.
uiLang("zh-CN");

const rewind = async (h: any, sid: string, args: any) => {
  const op = await h.c.operation(sid, "rewind", args);
  const r = await until(
    () => h.c.operationStatus(sid, op.id),
    (r: any) => !!r.result,
    300,
  );
  await h.settle(sid);
  return r;
};
const read = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : null);

test("rewind files (codex): Daisy's checkpoints restore the edit tool's files; commands' changes named; conflicts refuse everything", async () => {
  const h: any = await setup();
  try {
    // The real path: the node reports its roots resolved (macOS /var → /private/var);
    // a workspace under the unresolved one is refused once it has (a race before).
    const ws = join(realpathSync(h.dir), "ws");
    mkdirSync(ws);
    writeFileSync(join(ws, "keep.txt"), "orig\n");
    writeFileSync(join(ws, "other.txt"), "o\n");
    const w = await h.c.request("/workspaces", "POST", {
      nodeId: h.config.nodeId,
      label: "ws",
      path: ws,
    });
    const s = await h.c.create({
      agent: "codex",
      title: "回退文件",
      profileId: h.profile("codex").id,
      workspaceId: w.id,
    });
    const t1 = await h.c.send(
      s.id,
      "第一轮\nFX_PATCH keep.txt v1",
      [],
      "rf-codex-1",
    );
    await h.settle(s.id);
    const t2 = await h.c.send(
      s.id,
      "第二轮\nFX_PATCH keep.txt v2\nFX_ADD sub/new.txt n\nFX_SHELL other.txt changed\nFX_OUTSIDE /etc/hosts\nFX_DECLINE declined.txt x",
      [],
      "rf-codex-2",
    );
    const snap = await h.settle(s.id);
    assert.equal(read(join(ws, "keep.txt")), "v2\n");
    assert.equal(read(join(ws, "sub/new.txt")), "n\n");
    // The toggle is offered: the node reports Daisy's file checkpoints.
    assert.equal(snap.rewindFiles, "fallback");
    const turnOf = (id: string) =>
      snap.items.find((i: any) => i.id === `user:${id}`)?.native?.turnId;
    assert.ok(
      turnOf(t1.id) && turnOf(t2.id) && turnOf(t1.id) !== turnOf(t2.id),
    );
    // Daisy's state root is not in the workspace's snapshots.
    const reverts = () =>
      h.lines(h.thread).filter((x: any) => x.via === "thread/revert");

    const r = await rewind(h, s.id, { itemId: `user:${t2.id}`, files: true });
    assert.equal(r.result.error, undefined);
    assert.equal(r.result.files.via, "fallback");
    assert.equal(r.result.files.reverted, true);
    // The workspace's realpath (macOS: /var → /private/var).
    assert.deepEqual(r.result.files.filesChanged.sort(), [
      join(realpathSync(ws), "keep.txt"),
      join(realpathSync(ws), "sub/new.txt"),
    ]);
    assert.equal(read(join(ws, "keep.txt")), "v1\n");
    assert.equal(read(join(ws, "sub/new.txt")), null, "created → removed");
    assert.equal(
      read(join(ws, "other.txt")),
      "changed\n",
      "a command's change stays",
    );
    assert.deepEqual(r.result.files.others, ["other.txt"]);
    assert.deepEqual(r.result.files.notRestored, [
      { path: "/etc/hosts", why: "outside" },
    ]);
    assert.deepEqual(
      reverts().map((x: any) => x.beforeTurnId),
      [turnOf(t2.id)],
    );
    const after = await until(
      () => h.c.snapshot(s.id),
      (x: any) => !x.items.some((i: any) => i.id === `user:${t2.id}`),
    );
    const notice = after.items.find((i: any) =>
      /已回退 1 轮/.test(i.text || ""),
    );
    assert.match(
      notice.text,
      new RegExp(
        `文件已回退：2 个 AI 用编辑工具改过的文件整个恢复.*${PRODUCT_NAME} 快照.*同一轮里其他人`,
      ),
    );
    assert.match(notice.text, /\/etc\/hosts（在工作目录之外）/);
    assert.match(
      notice.text,
      /另有 1 个文件之后被命令或其他方式改过，没有回退：other\.txt/,
    );

    // A file changed after the AI's edit: refused — history and files untouched.
    const t3 = await h.c.send(
      s.id,
      "第三轮\nFX_PATCH keep.txt v3",
      [],
      "rf-codex-3",
    );
    await h.settle(s.id);
    writeFileSync(join(ws, "keep.txt"), "hand\n");
    const r2 = await rewind(h, s.id, { itemId: `user:${t3.id}`, files: true });
    assert.match(r2.result.error, /1 个文件在 AI 改过之后又被改动：keep\.txt/);
    assert.equal(r2.result.files.reason, "conflict");
    assert.equal(reverts().length, 1, "no thread/revert");
    assert.equal(read(join(ws, "keep.txt")), "hand\n");
    const kept = await h.c.snapshot(s.id);
    assert.ok(kept.items.some((i: any) => i.id === `user:${t3.id}`));
    // The history only (no 「同时撤销文件」): fine, files left alone.
    const r3 = await rewind(h, s.id, { itemId: `user:${t3.id}` });
    assert.equal(r3.result.error, undefined);
    assert.equal(r3.result.files.reason, "not-asked");
    assert.equal(read(join(ws, "keep.txt")), "hand\n");
    // Back to before turn 1: keep.txt is not as turn 1 left it → refused;
    // put back as the AI left it → restored to the original.
    const r4 = await rewind(h, s.id, { itemId: `user:${t1.id}`, files: true });
    assert.match(r4.result.error, /keep\.txt/);
    writeFileSync(join(ws, "keep.txt"), "v1\n");
    const r5 = await rewind(h, s.id, { itemId: `user:${t1.id}`, files: true });
    assert.equal(r5.result.error, undefined);
    assert.equal(read(join(ws, "keep.txt")), "orig\n");
    // Nothing of Daisy's own state ended up in the workspace.
    assert.deepEqual(readdirSync(ws).sort(), ["keep.txt", "other.txt", "sub"]);
  } finally {
    await h.close();
  }
});

test("rewind files (codex): turned off on the node → not offered, refused plainly (P4-11 C-3)", async () => {
  process.env.DAISY_CODEX_FILE_CHECKPOINTS = "0";
  const h: any = await setup();
  try {
    const s = await h.create("codex", "关闭");
    const t = await h.c.send(
      s.id,
      "一轮\nFX_PATCH off.txt x",
      [],
      "rf-off-0001",
    );
    const snap = await h.settle(s.id);
    assert.equal(snap.rewindFiles, "none");
    assert.equal(snap.features?.rewindFiles, "none");
    // P4-11 (C-3): an undeclared capability is refused, not half done.
    await assert.rejects(
      h.c.operation(s.id, "rewind", { itemId: `user:${t.id}`, files: true }),
      (e: any) => e.code === "capability_unsupported",
    );
    const r = await rewind(h, s.id, { itemId: `user:${t.id}` });
    assert.equal(r.result.error, undefined);
    assert.equal(read(join(h.dir, "off.txt")), "x\n");
    assert.ok(
      !existsSync(join(h.config.identityRoot, "file-checkpoints", s.id)),
    );
  } finally {
    delete process.env.DAISY_CODEX_FILE_CHECKPOINTS;
    await h.close();
  }
});

test("rewind files (codex): a rewound turn without a checkpoint refuses up front, said on the turn", async () => {
  process.env.DAISY_CODEX_CHECKPOINT_FILES = "1";
  const h: any = await setup();
  try {
    // The real path: the node reports its roots resolved (macOS /var → /private/var);
    // a workspace under the unresolved one is refused once it has (a race before).
    const ws = join(realpathSync(h.dir), "ws");
    mkdirSync(ws);
    writeFileSync(join(ws, "a.txt"), "a\n");
    writeFileSync(join(ws, "b.txt"), "b\n");
    const w = await h.c.request("/workspaces", "POST", {
      nodeId: h.config.nodeId,
      label: "ws",
      path: ws,
    });
    const s = await h.c.create({
      agent: "codex",
      title: "无快照",
      profileId: h.profile("codex").id,
      workspaceId: w.id,
    });
    const t = await h.c.send(s.id, "一轮\nFX_PATCH a.txt v1", [], "rf-miss-01");
    const snap = await h.settle(s.id);
    assert.ok(
      snap.items.some((i: any) =>
        new RegExp(`本轮没有 ${PRODUCT_NAME} 文件快照（工作目录文件太多`).test(i.name || ""),
      ),
    );
    const r = await rewind(h, s.id, { itemId: `user:${t.id}`, files: true });
    assert.match(r.result.error, new RegExp(`没有 ${PRODUCT_NAME} 文件快照（工作目录文件太多`));
    assert.equal(r.result.files.reason, "no-checkpoint");
    assert.equal(
      h.lines(h.thread).filter((x: any) => x.via === "thread/revert").length,
      0,
    );
    assert.equal(read(join(ws, "a.txt")), "v1\n");
    // History only still works.
    const r2 = await rewind(h, s.id, { itemId: `user:${t.id}` });
    assert.equal(r2.result.error, undefined);
  } finally {
    delete process.env.DAISY_CODEX_CHECKPOINT_FILES;
    await h.close();
  }
});

const job = (sid: string, extra: any = {}) =>
  ({
    id: "job-" + Math.random().toString(36).slice(2),
    session: { id: sid, agent: "codex", workspaceMode: "shared", ...extra },
  }) as any;
const fallback = { rewind: { history: "native", files: "fallback" } };
const git = (cwd: string, ...a: string[]) =>
  execFileSync("git", a, { cwd, encoding: "utf8" });
/** One recorded turn: `edit` changes the files, `changes` are its fileChange paths. */
async function turn(
  sid: string,
  cwd: string,
  turnId: string,
  edit: () => void,
  /** [path, kind, move destination?] */
  changes: ([string, string] | [string, string, string])[],
) {
  const cp = (await TurnCheckpoint.begin(job(sid), cwd, fallback))!;
  assert.ok(cp && !cp.error, cp?.error ?? "no checkpoint");
  cp.started(turnId);
  edit();
  cp.fileChange({
    status: "completed",
    changes: changes.map(([path, type, to]) => ({
      path: path.startsWith("/") ? path : join(cwd, path),
      kind: { type, ...(to ? { move_path: join(cwd, to) } : {}) },
    })),
  });
  await cp.end();
}

test("file checkpoints on a git workspace: only bytes equal to the index blob are referenced (eol / filters copied), the repository is not written, no hooks / fsmonitor run, outside / symlinked / nested paths never restored, an ignored file the AI created where nothing was is deleted", async () => {
  const base = mkdtempSync(join(tmpdir(), "daisy-fcp-"));
  const state = join(base, "state"),
    repo = join(base, "repo");
  configureFileCheckpoints({ stateRoot: state });
  try {
    mkdirSync(repo);
    git(repo, "init", "-q");
    git(repo, "config", "user.email", "t@t");
    git(repo, "config", "user.name", "t");
    writeFileSync(join(repo, ".gitignore"), "dist/\n");
    writeFileSync(join(repo, ".gitattributes"), "crlf.txt text eol=crlf\n");
    writeFileSync(join(repo, "a.txt"), "tracked original\n");
    writeFileSync(join(repo, "crlf.txt"), "line one\nline two\n");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "init");
    // Checked out through the eol filter: CRLF on disk, LF in the blob.
    rmSync(join(repo, "crlf.txt"));
    git(repo, "checkout", "--", "crlf.txt");
    const crlf = readFileSync(join(repo, "crlf.txt"));
    assert.match(crlf.toString(), /\r\n/);
    writeFileSync(join(repo, "u.txt"), "untracked original\n");
    mkdirSync(join(base, "outside"));
    symlinkSync(join(base, "outside"), join(repo, "link"));
    mkdirSync(join(repo, "inner"));
    git(join(repo, "inner"), "init", "-q");
    writeFileSync(join(repo, "inner/z.txt"), "nested\n");
    // Review M4: an fsmonitor command in the repository's config never runs.
    const marker = join(base, "fsmonitor-ran");
    const hook = join(base, "fsmonitor.sh");
    writeFileSync(hook, `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
    git(repo, "config", "core.fsmonitor", hook);
    const objects = () =>
      execFileSync("find", [join(repo, ".git/objects"), "-type", "f"], {
        encoding: "utf8",
      });
    const before = {
      objects: objects(),
      index: statSync(join(repo, ".git/index")).mtimeMs,
    };

    await turn(
      "s1",
      repo,
      "T1",
      () => {
        writeFileSync(join(repo, "a.txt"), "ai edit\n");
        writeFileSync(join(repo, "u.txt"), "ai edit u\n");
        writeFileSync(join(repo, "crlf.txt"), "ai edit crlf\n");
        mkdirSync(join(repo, "dist"));
        writeFileSync(join(repo, "dist/x.js"), "built\n");
        writeFileSync(join(repo, "inner/z.txt"), "ai nested\n");
      },
      [
        ["a.txt", "update"],
        ["u.txt", "update"],
        ["crlf.txt", "update"],
        ["dist/x.js", "add"],
        ["inner/z.txt", "update"],
        [join(base, "escape.txt"), "add"],
        [join(repo, "link/inside.txt"), "add"],
        [join(repo, ".git/config"), "update"],
      ],
    );
    assert.equal(existsSync(marker), false, "fsmonitor never ran");
    assert.equal(objects(), before.objects);
    assert.equal(statSync(join(repo, ".git/index")).mtimeMs, before.index);
    const dir = join(state, "file-checkpoints", "s1");
    const has = (b: Buffer) => {
      const id = blobId(b);
      return existsSync(join(dir, "blobs", id.slice(0, 2), id));
    };
    assert.equal(has(Buffer.from("tracked original\n")), false, "referenced");
    assert.equal(has(Buffer.from("untracked original\n")), true);
    assert.equal(has(crlf), true, "the eol-converted bytes are copied (H1)");
    // Review L1: private store.
    if (process.platform !== "win32") assert.equal(statSync(dir).mode & 0o777, 0o700);
    if (process.platform !== "win32") assert.equal(statSync(join(dir, "index.json")).mode & 0o777, 0o600);

    const plan = await planRewindFiles("s1", repo, "T1");
    assert.deepEqual(plan.conflicts, []);
    assert.deepEqual(plan.missing, []);
    // dist/ was not in the pre ignored list nor the
    // snapshot → provably absent then; the AI created it → deleted.
    assert.deepEqual(plan.restore.map((x) => x.path).sort(), [
      "a.txt",
      "crlf.txt",
      "dist/x.js",
      "u.txt",
    ]);
    assert.equal(plan.restore.find((x) => x.path === "dist/x.js")!.data, null);
    assert.deepEqual(
      plan.notRestored.map((x) => `${x.path}:${x.why}`).sort(),
      [
        `${join(base, "escape.txt")}:outside`,
        `${join(repo, ".git/config")}:outside`,
        `${join(repo, "link/inside.txt")}:outside`,
        "inner/z.txt:nested-repo",
      ].sort(),
    );
    assert.deepEqual(plan.unrestorable, []);
    const done = await applyRewindFiles(plan);
    assert.equal(done.reverted, true);
    assert.equal(done.complete, true);
    assert.equal(read(join(repo, "a.txt")), "tracked original\n");
    assert.equal(read(join(repo, "u.txt")), "untracked original\n");
    assert.deepEqual(readFileSync(join(repo, "crlf.txt")), crlf, "CRLF kept");
    assert.equal(read(join(repo, "dist/x.js")), null, "AI-created, ignored: deleted");
    assert.equal(read(join(repo, "inner/z.txt")), "ai nested\n");
    assert.deepEqual(readdirSync(join(base, "outside")), []);
    assert.ok(!readdirSync(repo).some((f) => /(daisy|harbor)-restore/.test(f)));
    // Paths: inside only, never through a symlink, never .git (or a look-alike).
    assert.equal(workspacePath(repo, join(repo, "b/c.txt")), "b/c.txt");
    assert.equal(workspacePath(repo, "../x"), null);
    assert.equal(workspacePath(repo, join(repo, "link/y")), null);
    assert.equal(workspacePath(repo, join(repo, ".git/HEAD")), null);
    assert.equal(forbidden(".g​it/config"), true);
    assert.equal(forbidden(".GIT./config"), true);
    assert.equal(forbidden("src/.gitignore"), false);
    await dropCheckpointsFrom("s1", "T1");
    assert.deepEqual(
      (await planRewindFiles("s1", repo, "T1")).missing.map((x) => x.why),
      ["no-record"],
    );
  } finally {
    configureFileCheckpoints({ stateRoot: null });
    rmSync(base, { recursive: true, force: true });
  }
});

test("file checkpoints: unreadable is unknown (never deleted), a change during the restore is not overwritten, declined patches are not counted, a missing cwd is a clean error", async () => {
  const base = mkdtempSync(join(tmpdir(), "daisy-fcp-h2-"));
  const state = join(base, "state"),
    ws = join(base, "ws");
  mkdirSync(ws);
  configureFileCheckpoints({ stateRoot: state });
  try {
    writeFileSync(join(ws, "k.txt"), "k0\n");
    writeFileSync(join(ws, "secret.txt"), "secret\n");
    mkdirSync(join(ws, "locked"));
    writeFileSync(join(ws, "locked/old.txt"), "old\n");
    chmodSync(join(ws, "secret.txt"), 0);
    chmodSync(join(ws, "locked"), 0);
    const cp = (await TurnCheckpoint.begin(job("h2"), ws, fallback))!;
    cp.started("T1");
    chmodSync(join(ws, "secret.txt"), 0o644);
    chmodSync(join(ws, "locked"), 0o755);
    writeFileSync(join(ws, "secret.txt"), "ai\n");
    writeFileSync(join(ws, "locked/new.txt"), "ai new\n");
    writeFileSync(join(ws, "k.txt"), "k1\n");
    cp.fileChange({
      status: "completed",
      changes: [
        { path: join(ws, "secret.txt"), kind: { type: "add" } },
        { path: join(ws, "locked/new.txt"), kind: { type: "add" } },
        { path: join(ws, "k.txt"), kind: { type: "update" } },
      ],
    });
    // Review M2: a declined patch changed nothing — not counted.
    cp.fileChange({
      status: "declined",
      changes: [{ path: join(ws, "nope.txt"), kind: { type: "add" } }],
    });
    await cp.end();
    const plan = await planRewindFiles("h2", ws, "T1");
    assert.deepEqual(plan.notRestored.map((x) => `${x.path}:${x.why}`).sort(), [
      "locked/new.txt:unreadable",
      "secret.txt:unreadable",
    ]);
    assert.deepEqual(
      plan.restore.map((x) => x.path),
      ["k.txt"],
    );
    // Review M1: changed between the plan and the write → left alone.
    writeFileSync(join(ws, "k.txt"), "someone\n");
    const done = await applyRewindFiles(plan);
    assert.equal(done.complete, false);
    assert.deepEqual(done.notRestored?.at(-1), {
      path: "k.txt",
      why: "changed-during-rewind",
    });
    assert.equal(read(join(ws, "k.txt")), "someone\n");
    assert.equal(read(join(ws, "secret.txt")), "ai\n", "never deleted");
    assert.equal(read(join(ws, "locked/new.txt")), "ai new\n");
    // Review M3: content is read and verified in the plan — a lost blob is
    // known before anything is rewound.
    rmSync(join(state, "file-checkpoints", "h2", "blobs"), {
      recursive: true,
      force: true,
    });
    writeFileSync(join(ws, "k.txt"), "k1\n");
    const lost = await planRewindFiles("h2", ws, "T1");
    assert.deepEqual(lost.restore, []);
    assert.ok(
      lost.notRestored.some((x) => x.path === "k.txt" && x.why === "missing"),
    );
    // Review L7: a missing cwd is a clean error.
    await assert.rejects(
      planRewindFiles("h2", join(base, "gone"), "T1"),
      /会话工作目录不存在/,
    );
  } finally {
    try {
      chmodSync(join(ws, "locked"), 0o755);
    } catch {}
    configureFileCheckpoints({ stateRoot: null });
    rmSync(base, { recursive: true, force: true });
  }
});

test("file checkpoints: caps — too-large listed, turns capped oldest first, too many files / home dir → no checkpoint (said), sidecars / read-only / older CLIs none, rewound turns all needed, deleted sessions swept", async () => {
  const base = mkdtempSync(join(tmpdir(), "daisy-fcp-cap-"));
  const state = join(base, "state"),
    ws = join(base, "ws");
  mkdirSync(ws);
  configureFileCheckpoints({ stateRoot: state });
  process.env.DAISY_CODEX_CHECKPOINT_TURNS = "2";
  process.env.DAISY_CODEX_CHECKPOINT_FILE_MB = String(10 / (1024 * 1024));
  try {
    writeFileSync(join(ws, "big.txt"), "more than ten bytes\n");
    writeFileSync(join(ws, "s.txt"), "small\n");
    for (const t of ["T1", "T2", "T3"])
      await turn(
        "s2",
        ws,
        t,
        () => {
          writeFileSync(join(ws, "big.txt"), `big edit in ${t}\n`);
          writeFileSync(join(ws, "s.txt"), t);
        },
        [
          ["big.txt", "update"],
          ["s.txt", "update"],
        ],
      );
    assert.equal(
      (await planRewindFiles("s2", ws, "T1")).reason,
      "no-checkpoint",
    );
    // Review L4: every rewound turn needs one.
    assert.deepEqual(
      (await planRewindFiles("s2", ws, "T2", ["T2", "TX", "T3"])).missing,
      [{ turnId: "TX", why: "no-record" }],
    );
    const plan = await planRewindFiles("s2", ws, "T2", ["T2", "T3"]);
    assert.deepEqual(plan.notRestored, [{ path: "big.txt", why: "too-large" }]);
    assert.deepEqual(
      plan.restore.map((x) => x.path),
      ["s.txt"],
    );
    await applyRewindFiles(plan);
    assert.equal(read(join(ws, "s.txt")), "T1");
    // Review L3: the target has no record, the later ones still go.
    await dropCheckpointsFrom("s2", "T0", ["T0", "T2", "T3"]);
    assert.equal(
      (await planRewindFiles("s2", ws, "T2")).missing[0].why,
      "no-record",
    );
    // Review M6: too many files / the home folder → no checkpoint, said.
    process.env.DAISY_CODEX_CHECKPOINT_FILES = "1";
    const many = await TurnCheckpoint.begin(job("s4"), ws, fallback);
    assert.match(many!.error!, /文件太多/);
    delete process.env.DAISY_CODEX_CHECKPOINT_FILES;
    const home = await TurnCheckpoint.begin(job("s4"), homedir(), fallback);
    assert.match(home!.error!, /家目录/);
    // Not for: a sidecar, a read-only workspace, a CLI without the capability.
    assert.equal(
      await TurnCheckpoint.begin(
        job("s3", { sidecar: { role: "x" } }),
        ws,
        fallback,
      ),
      null,
    );
    assert.equal(
      await TurnCheckpoint.begin(
        job("s3", { workspaceMode: "read-only" }),
        ws,
        fallback,
      ),
      null,
    );
    assert.equal(
      await TurnCheckpoint.begin(job("s3"), ws, { rewind: { files: "none" } }),
      null,
    );
    assert.ok(!existsSync(join(state, "file-checkpoints", "s3")));
    // Review L1: a session the control plane no longer has is swept.
    await turn("s5", ws, "T1", () => {}, []);
    const asked: string[][] = [];
    configureFileCheckpoints({
      stateRoot: state,
      gone: async (ids) => (asked.push(ids), ids.filter((x) => x === "s5")),
    });
    await sweep(undefined, true);
    assert.ok(asked[0].includes("s5") && asked[0].includes("s2"));
    assert.ok(!existsSync(join(state, "file-checkpoints", "s5")));
    assert.ok(existsSync(join(state, "file-checkpoints", "s2")));
  } finally {
    delete process.env.DAISY_CODEX_CHECKPOINT_TURNS;
    delete process.env.DAISY_CODEX_CHECKPOINT_FILE_MB;
    delete process.env.DAISY_CODEX_CHECKPOINT_FILES;
    configureFileCheckpoints({ stateRoot: null });
    rmSync(base, { recursive: true, force: true });
  }
});

test("file checkpoints, rules changing: an ignored file that existed is never deleted when the rules change; a file whose content is missing refuses the restore and keeps the checkpoints", async () => {
  const base = mkdtempSync(join(tmpdir(), "daisy-fcp-rr-"));
  const state = join(base, "state"),
    repo = join(base, "repo"),
    ws = join(base, "ws");
  configureFileCheckpoints({ stateRoot: state });
  try {
    mkdirSync(repo);
    git(repo, "init", "-q");
    writeFileSync(join(repo, ".gitignore"), ".env\n");
    writeFileSync(join(repo, "f.txt"), "a\n");
    git(repo, "add", ".");
    git(repo, "-c", "user.name=x", "-c", "user.email=x", "commit", "-qm", "i");
    writeFileSync(join(repo, ".env"), "SECRET=1\n");
    // The AI un-ignores .env and "adds" it in the same turn.
    await turn(
      "ign",
      repo,
      "T1",
      () => {
        writeFileSync(join(repo, ".gitignore"), "\n");
        writeFileSync(join(repo, ".env"), "AI=1\n");
      },
      [
        [".gitignore", "update"],
        [".env", "add"],
      ],
    );
    const plan = await planRewindFiles("ign", repo, "T1");
    assert.deepEqual(plan.unrestorable, [{ path: ".env", why: "no-snapshot" }]);
    assert.ok(!plan.restore.some((x) => x.path === ".env"));
    await applyRewindFiles(plan);
    assert.equal(read(join(repo, ".env")), "AI=1\n", "never deleted");

    mkdirSync(ws);
    writeFileSync(join(ws, "u.txt"), "orig\n");
    writeFileSync(join(ws, "v.txt"), "o2\n");
    await turn(
      "miss",
      ws,
      "T1",
      () => {
        writeFileSync(join(ws, "u.txt"), "AI\n");
        writeFileSync(join(ws, "v.txt"), "AI2\n");
      },
      [
        ["u.txt", "update"],
        ["v.txt", "update"],
      ],
    );
    const id = blobId(Buffer.from("orig\n"));
    rmSync(
      join(state, "file-checkpoints", "miss", "blobs", id.slice(0, 2), id),
    );
    const lost = await planRewindFiles("miss", ws, "T1");
    assert.deepEqual(lost.unrestorable, [{ path: "u.txt", why: "missing" }]);
    assert.equal((await applyRewindFiles(lost)).complete, false);
  } finally {
    configureFileCheckpoints({ stateRoot: null });
    rmSync(base, { recursive: true, force: true });
  }
});

test("file checkpoints: an ignored file the AI created where nothing was (not in the pre ignored list nor snapshot) is deleted and verified across turns; a pre-existing ignored .env is never deleted nor copied; older manifests stay unknown", async () => {
  const base = mkdtempSync(join(tmpdir(), "daisy-fcp-ign-"));
  const state = join(base, "state"),
    repo = join(base, "repo");
  configureFileCheckpoints({ stateRoot: state });
  const stored = (sid: string, text: string) => {
    const id = blobId(Buffer.from(text));
    return existsSync(
      join(state, "file-checkpoints", sid, "blobs", id.slice(0, 2), id),
    );
  };
  try {
    mkdirSync(repo);
    git(repo, "init", "-q");
    writeFileSync(join(repo, ".gitignore"), ".env\ndist/\n");
    writeFileSync(join(repo, "f.txt"), "a\n");
    git(repo, "add", ".");
    git(repo, "-c", "user.name=x", "-c", "user.email=x", "commit", "-qm", "i");

    // The user's own ignored .env, rules unchanged: the AI edits it.
    writeFileSync(join(repo, ".env"), "SECRET=1\n");
    await turn(
      "own",
      repo,
      "T1",
      () => writeFileSync(join(repo, ".env"), "SECRET=1\nAI=1\n"),
      [[".env", "add"]],
    );
    const own = await planRewindFiles("own", repo, "T1");
    assert.deepEqual(own.unrestorable, [{ path: ".env", why: "no-snapshot" }]);
    assert.ok(!own.restore.some((x) => x.path === ".env"));
    await applyRewindFiles(own);
    assert.equal(read(join(repo, ".env")), "SECRET=1\nAI=1\n", "never deleted");
    assert.equal(stored("own", "SECRET=1\nAI=1\n"), false, "never copied");
    rmSync(join(repo, ".env"));

    // A new .env and dist/x.js the AI created: deleted on the rewind.
    await turn(
      "new",
      repo,
      "T1",
      () => {
        writeFileSync(join(repo, ".env"), "AI=1\n");
        mkdirSync(join(repo, "dist"));
        writeFileSync(join(repo, "dist/x.js"), "built\n");
        writeFileSync(join(repo, "f.txt"), "b\n");
      },
      [
        [".env", "add"],
        ["dist/x.js", "add"],
        ["f.txt", "update"],
      ],
    );
    // A later turn: the created files stay known (verified between turns).
    await turn(
      "new",
      repo,
      "T2",
      () => writeFileSync(join(repo, "f.txt"), "c\n"),
      [["f.txt", "update"]],
    );
    const plan = await planRewindFiles("new", repo, "T1", ["T1", "T2"]);
    assert.deepEqual(plan.conflicts, []);
    assert.deepEqual(plan.unrestorable, []);
    assert.deepEqual(
      plan.restore.map((x) => `${x.path}:${x.data === null}`).sort(),
      [".env:true", "dist/x.js:true", "f.txt:false"],
    );
    // Someone changes the AI's new .env afterwards: a conflict, never deleted.
    writeFileSync(join(repo, ".env"), "AI=1\nMINE=1\n");
    const after = await planRewindFiles("new", repo, "T1", ["T1", "T2"]);
    assert.deepEqual(after.conflicts, [{ path: ".env", why: "changed-after" }]);
    writeFileSync(join(repo, ".env"), "AI=1\n");
    const done = await applyRewindFiles(
      await planRewindFiles("new", repo, "T1", ["T1", "T2"]),
    );
    assert.equal(done.complete, true);
    assert.equal(read(join(repo, ".env")), null);
    assert.equal(read(join(repo, "dist/x.js")), null);
    assert.equal(read(join(repo, "f.txt")), "a\n");

    // Changed by someone between the AI's turns: refused, not deleted.
    await turn(
      "mid",
      repo,
      "T1",
      () => writeFileSync(join(repo, ".env"), "AI=1\n"),
      [[".env", "add"]],
    );
    writeFileSync(join(repo, ".env"), "AI=1\nMINE=1\n");
    await turn(
      "mid",
      repo,
      "T2",
      () => writeFileSync(join(repo, "f.txt"), "z\n"),
      [["f.txt", "update"]],
    );
    const mid = await planRewindFiles("mid", repo, "T1", ["T1", "T2"]);
    assert.deepEqual(mid.conflicts, [
      { path: ".env", why: "changed-between-turns" },
    ]);
    rmSync(join(repo, ".env"));
    writeFileSync(join(repo, "f.txt"), "a\n");

    // An older manifest (no ignored list): absence not provable, as before.
    await turn(
      "old",
      repo,
      "T1",
      () => writeFileSync(join(repo, ".env"), "AI=1\n"),
      [[".env", "add"]],
    );
    const dir = join(state, "file-checkpoints", "old");
    const idx = JSON.parse(readFileSync(join(dir, "index.json"), "utf8"));
    const mpath = join(dir, "m", idx.turns[0].pre + ".json.gz");
    const m = JSON.parse(gunzipSync(readFileSync(mpath)).toString());
    delete m.ignored;
    writeFileSync(mpath, gzipSync(JSON.stringify(m)));
    configureFileCheckpoints({ stateRoot: state }); // drops parsed manifests
    const old = await planRewindFiles("old", repo, "T1");
    assert.deepEqual(old.unrestorable, [{ path: ".env", why: "no-snapshot" }]);
    await applyRewindFiles(old);
    assert.equal(read(join(repo, ".env")), "AI=1\n", "never deleted");
  } finally {
    configureFileCheckpoints({ stateRoot: null });
    rmSync(base, { recursive: true, force: true });
  }
});

test("file checkpoints (followups-1109 review A / B / C): an ignored cwd proves nothing absent; a path through a symlinked folder or a case alias is never deleted", async () => {
  const base = mkdtempSync(join(tmpdir(), "daisy-fcp-alias-"));
  configureFileCheckpoints({ stateRoot: join(base, "state") });
  try {
    const repo = join(base, "repo");
    mkdirSync(repo);
    git(repo, "init", "-q");
    writeFileSync(join(repo, ".gitignore"), "scratch/\n");
    mkdirSync(join(repo, "realdir"));
    writeFileSync(join(repo, "realdir/foo.txt"), "tracked\n");
    git(repo, "add", ".");
    git(repo, "-c", "user.name=x", "-c", "user.email=x", "commit", "-qm", "i");
    symlinkSync("realdir", join(repo, "link"));
    // A: the session's cwd is an ignored folder of the repo (`./`).
    const scratch = join(repo, "scratch");
    mkdirSync(scratch);
    writeFileSync(join(scratch, "data.csv"), "USER DATA\n");
    await turn(
      "A",
      scratch,
      "T1",
      () => writeFileSync(join(scratch, "data.csv"), "AI\n"),
      [["data.csv", "add"]],
    );
    const a = await planRewindFiles("A", scratch, "T1");
    assert.deepEqual(a.restore, []);
    assert.deepEqual(a.unrestorable, [{ path: "data.csv", why: "no-snapshot" }]);
    await applyRewindFiles(a);
    assert.equal(read(join(scratch, "data.csv")), "AI\n", "never deleted");
    // B: the AI "adds" link/foo.txt = the tracked realdir/foo.txt.
    await turn(
      "B",
      repo,
      "T1",
      () => writeFileSync(join(repo, "link/foo.txt"), "AI\n"),
      [["link/foo.txt", "add"]],
    );
    const b = await planRewindFiles("B", repo, "T1");
    assert.deepEqual(b.restore, []);
    assert.deepEqual(b.unrestorable, [
      { path: "link/foo.txt", why: "not-canonical" },
    ]);
    await applyRewindFiles(b);
    assert.equal(read(join(repo, "realdir/foo.txt")), "AI\n", "never deleted");
    // C (simulated): only the exact listed name of a real folder is canonical.
    writeFileSync(join(repo, ".env"), "x\n");
    const real = realpathSync(repo);
    assert.equal(await canonical(real, ".env"), true);
    assert.equal(await canonical(real, ".ENV"), false);
    assert.equal(await canonical(real, "link/foo.txt"), false);
    assert.equal(await canonical(real, "realdir/foo.txt"), true);
    assert.equal(await canonical(real, "missing/x"), false);
  } finally {
    configureFileCheckpoints({ stateRoot: null });
    rmSync(base, { recursive: true, force: true });
  }
});

test("file checkpoints (followups-1109 review): a move from a nested repo or from outside never deletes its destination (the only copy); a plan with anything unrestorable deletes nothing", async () => {
  const base = mkdtempSync(join(tmpdir(), "daisy-fcp-move-"));
  configureFileCheckpoints({ stateRoot: join(base, "state") });
  try {
    const repo = join(base, "repo");
    mkdirSync(repo);
    git(repo, "init", "-q");
    writeFileSync(join(repo, "a.txt"), "A\n");
    git(repo, "add", ".");
    git(repo, "-c", "user.name=x", "-c", "user.email=x", "commit", "-qm", "i");
    mkdirSync(join(repo, "inner"));
    git(join(repo, "inner"), "init", "-q");
    writeFileSync(join(repo, "inner/data.txt"), "NESTED USER\n");
    await turn(
      "N",
      repo,
      "T1",
      () => renameSync(join(repo, "inner/data.txt"), join(repo, "moved.txt")),
      [["inner/data.txt", "update", "moved.txt"]],
    );
    const n = await planRewindFiles("N", repo, "T1");
    assert.deepEqual(n.restore, []);
    assert.deepEqual(n.unrestorable, [{ path: "moved.txt", why: "move-source" }]);
    await applyRewindFiles(n);
    assert.equal(read(join(repo, "moved.txt")), "NESTED USER\n");

    const out = join(base, "out");
    mkdirSync(out);
    writeFileSync(join(out, "s.txt"), "OUTSIDE USER\n");
    await turn(
      "O",
      repo,
      "T1",
      () => renameSync(join(out, "s.txt"), join(repo, "moved2.txt")),
      [[join(out, "s.txt"), "update", "moved2.txt"]],
    );
    const o = await planRewindFiles("O", repo, "T1");
    assert.deepEqual(o.restore, []);
    assert.deepEqual(o.unrestorable, [
      { path: "moved2.txt", why: "move-source" },
    ]);
    await applyRewindFiles(o);
    assert.equal(read(join(repo, "moved2.txt")), "OUTSIDE USER\n");

    // A move inside the workspace still rewinds whole: back, and deleted.
    await turn(
      "M",
      repo,
      "T1",
      () => renameSync(join(repo, "a.txt"), join(repo, "b.txt")),
      [["a.txt", "update", "b.txt"]],
    );
    const m = await planRewindFiles("M", repo, "T1");
    assert.deepEqual(m.unrestorable, []);
    assert.equal((await applyRewindFiles(m)).complete, true);
    assert.equal(read(join(repo, "a.txt")), "A\n");
    assert.equal(read(join(repo, "b.txt")), null);

    // Defense in depth: anything unrestorable → no delete is carried out.
    writeFileSync(join(repo, "new.txt"), "AI\n");
    const done = await applyRewindFiles({
      ...m,
      restore: [{ path: "new.txt", data: null, mode: 0o644, expect: blobId(Buffer.from("AI\n")) }],
      unrestorable: [{ path: "x", why: "missing" }],
    } as any);
    assert.equal(read(join(repo, "new.txt")), "AI\n");
    assert.ok(done.notRestored?.some((x) => x.why === "kept-unrestorable"));
  } finally {
    configureFileCheckpoints({ stateRoot: null });
    rmSync(base, { recursive: true, force: true });
  }
});

test("rewind files (codex): an AI-edited file Daisy cannot restore refuses the whole rewind, history-only still works", async () => {
  const h: any = await setup();
  try {
    // The real path: the node reports its roots resolved (macOS /var → /private/var);
    // a workspace under the unresolved one is refused once it has (a race before).
    const ws = join(realpathSync(h.dir), "ws");
    mkdirSync(join(ws, "node_modules"), { recursive: true });
    writeFileSync(join(ws, "node_modules/dep.js"), "dep\n");
    writeFileSync(join(ws, "a.txt"), "a\n");
    const w = await h.c.request("/workspaces", "POST", {
      nodeId: h.config.nodeId,
      label: "ws",
      path: ws,
    });
    const s = await h.c.create({
      agent: "codex",
      title: "无法恢复",
      profileId: h.profile("codex").id,
      workspaceId: w.id,
    });
    const t = await h.c.send(
      s.id,
      "一轮\nFX_PATCH a.txt v1\nFX_PATCH node_modules/dep.js ai",
      [],
      "rf-unres-1",
    );
    await h.settle(s.id);
    const r = await rewind(h, s.id, { itemId: `user:${t.id}`, files: true });
    assert.match(
      r.result.error,
      /1 个 AI 改过的文件无法恢复：node_modules\/dep\.js/,
    );
    assert.equal(r.result.files.reason, "unrestorable");
    assert.equal(
      h.lines(h.thread).filter((x: any) => x.via === "thread/revert").length,
      0,
    );
    assert.equal(read(join(ws, "a.txt")), "v1\n");
    const r2 = await rewind(h, s.id, { itemId: `user:${t.id}` });
    assert.equal(r2.result.error, undefined);
  } finally {
    await h.close();
  }
});

test("file checkpoints: the age sweep spares sessions online / running here; an older store gets private modes", async () => {
  const base = mkdtempSync(join(tmpdir(), "daisy-fcp-sw-"));
  const state = join(base, "state"),
    ws = join(base, "ws");
  mkdirSync(ws);
  writeFileSync(join(ws, "a.txt"), "a\n");
  configureFileCheckpoints({ stateRoot: state });
  try {
    await turn("old", ws, "T1", () => {}, []);
    await turn("live", ws, "T1", () => {}, []);
    const fc = join(state, "file-checkpoints");
    chmodSync(join(fc, "old"), 0o755);
    process.env.DAISY_CODEX_CHECKPOINT_TTL_DAYS = String(1 / 86400_000);
    await new Promise((r) => setTimeout(r, 20));
    configureFileCheckpoints({ stateRoot: state, kept: () => ["live"] });
    await new Promise((r) => setTimeout(r, 50));
    if (process.platform !== "win32") assert.equal(statSync(join(fc, "old")).mode & 0o777, 0o700);
    await sweep(undefined, true);
    assert.ok(!existsSync(join(fc, "old")));
    assert.ok(existsSync(join(fc, "live")));
  } finally {
    delete process.env.DAISY_CODEX_CHECKPOINT_TTL_DAYS;
    configureFileCheckpoints({ stateRoot: null });
    rmSync(base, { recursive: true, force: true });
  }
});

test("capabilities, notice and banner: Codex files by Daisy, version-gated; wording per route", () => {
  assert.deepEqual(AGENT_CAPABILITIES.codex.rewind, {
    history: "native",
    files: "fallback",
  });
  assert.equal(
    capabilitiesFor("codex", "codex-cli 0.150.0").rewind!.files,
    "none",
  );
  assert.equal(
    capabilitiesFor("codex", "codex-cli 0.157.1").rewind!.files,
    "fallback",
  );
  assert.equal(
    rewindFilesRoute(
      { agentFeatures: { codex: capabilitiesFor("codex", "0.157.1") } },
      "codex",
    ),
    "fallback",
  );
  // ADR-152: a report from a Runner before the rename says "harbor".
  assert.equal(
    rewindFilesRoute(
      { agentFeatures: { codex: { version: 1, rewind: { history: "native", files: "harbor" } } } },
      "codex",
    ),
    "fallback",
  );
  assert.equal(rewindFilesRoute({}, "codex"), "none");
  assert.equal(rewindFilesRoute({}, "claude"), "native");
  assert.equal(canRewindFiles("codex"), false);
  assert.equal(canRewindFiles("codex", "fallback"), true);
  assert.equal(canRewindFiles("codex", "harbor"), true);
  assert.equal(canRewindFiles("claude", "none"), false);
  assert.match(
    editBannerText("codex", true, "fallback"),
    new RegExp(`${PRODUCT_NAME} 每轮的快照.*整个拒绝`),
  );
  assert.equal(
    editBannerText("codex", true, "harbor"),
    editBannerText("codex", true, "fallback"),
  );
  assert.match(editBannerText("codex", false, "fallback"), /文件改动不会撤销/);
  assert.match(editBannerText("codex", true), /文件改动不会撤销/);
  // ADR-152: the same notice for a result from before the rename ("harbor").
  for (const via of ["fallback", "harbor"])
    assert.match(
      rewindNotice(
        1,
        { files: { reverted: false, via, reason: "no-checkpoint" } },
        "codex",
      ),
      new RegExp(`没有 ${PRODUCT_NAME} 文件快照`),
    );
  assert.match(
    rewindNotice(
      1,
      {
        files: {
          reverted: false,
          via: "fallback",
          reason: "nothing",
          others: ["x.sh"],
          othersCount: 1,
        },
      },
      "codex",
    ),
    /没有用编辑工具改过文件.*另有 1 个文件.*x\.sh/,
  );
  // An older Runner (no via) for Codex still says Codex cannot.
  assert.match(
    rewindNotice(
      1,
      { files: { reverted: false, reason: "unsupported" } },
      "codex",
    ),
    /Codex 不支持撤销文件改动/,
  );
});

test("the Runner configures checkpoints after `live` / `jobSessions` exist (no TDZ in `kept`)", () => {
  const src = readFileSync(
    new URL("../packages/daisy/src/turns/worker.ts", import.meta.url),
    "utf8",
  );
  const at = src.indexOf("configureFileCheckpoints({");
  assert.ok(at > 0);
  assert.ok(at > src.indexOf("const live = new LiveRegistry("));
  assert.ok(at > src.indexOf("jobSessions: string[] = []"));
});
