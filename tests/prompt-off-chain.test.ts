import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { managedIdentityDir } from "../packages/daisy/src/turns/identity.ts";
import { shippedPacks } from "../packages/contracts/src/i18n-node.ts";
import { setup, until } from "./fixtures/scheduler-harness.ts";
/**
 * The layered prompt switched off (the default): the whole chain — the control
 * plane's claim, the Runner's adapters, what each engine is launched with
 * and what each turn says — is what it was before the layered prompt, to
 * the byte. Claude Code and Codex, each:
 *
 *   - an ordinary session, first turn;
 *   - a second turn on the live process; a turn after the Runner
 *     restarted (the conversation resumed);
 *   - a session on its own branch (独立分支);
 *   - a forced read-only session;
 *
 * and beside the launches: every audit item the turns left behind (their
 * names and fields — none more than before), and the fields of the node's
 * state sync answer (was the heartbeat's).
 *
 * The snapshot (tests/fixtures/prompt-off-chain-base.json) was written by
 * running this very file on the tree before the layered prompt (ebef850:
 * `DAISY_WRITE_SNAPSHOT=<file> node --import tsx --test
 * tests/prompt-off-chain.test.ts`). Never regenerate it from newer code.
 *
 * P1-01 edited it by hand, only for what P1-01 removed on purpose: the
 * resident and 「只问」 side-branch entries (residents and the 群聊 routing
 * of 「只问」 waited for stage 4), the 群聊 CLI note at
 * the end of every turn (from 「【Harbor 协作】」 to 「它在本轮结束时失效。」),
 * the heartbeat's `channelTitles` and the audit count of the four removed
 * turns. Everything else is the base commit's.
 *
 * P1-02 edited it by hand, only for what P1-02 changed on purpose: the
 * heartbeat became the in-process state sync (`heartbeat-fields` →
 * `sync-fields`) and its `release` went (no control plane to follow).
 *
 * P5-04 edited it by hand, only for what phase 4 added on purpose (P4-07,
 * ADR-127: the A2A client tools): `mcp__harbor__agents` /
 * `mcp__harbor__call_result` in Claude's allowed tools and `harbor_agents`
 * / `harbor_call_agent` / `harbor_call_result` in Codex's dynamic tools —
 * in the ordinary, resumed and isolated entries, measured on macOS. The
 * read-only entries were not touched (no Bubblewrap on macOS to measure
 * them; the Linux marker stays until they are).
 *
 * P6-04 (ADR-154) edited it, only for the rename the model reads: the
 * product name in the timers note (「【Daisy 定时与后台】」, 「这些由 Daisy
 * 保存」), Claude Code's MCP server `harbor` → `daisy` (`mcp__daisy__*` in
 * the allowed tools and the note) and Codex's `harbor_*` → `daisy_*` (the
 * dynamic tools and the note) — every entry, the read-only ones by the
 * same substitution. Checked: the other entries equal a fresh run of this
 * file on macOS (DAISY_WRITE_SNAPSHOT), and the word diff is only those
 * tokens. Sessions started by a Runner before ADR-154 keep the old names
 * (model-names.test.ts).
 *
 * P6-25 edited the two read-only entries by hand, only for what P5-04
 * deferred (above): the A2A client tools, `mcp__daisy__agents` /
 * `mcp__daisy__call_result` in Claude's allowed tools (argv and initialize)
 * and `daisy_agents` / `daisy_call_agent` / `daisy_call_result` in Codex's
 * dynamic tools — the same tools in the same places as the ordinary
 * entries (`toolsFor` does not depend on the workspace mode). Linux CI
 * (run 44289151230) showed exactly that difference for read-only:claude,
 * turns identical; not measurable on macOS (no Bubblewrap).
 */
const SNAPSHOT = "tests/fixtures/prompt-off-chain-base.json";
/**
 * P6-24 (ADR-159 §6): each language pinned on its own. The Chinese
 * snapshot above is the base commit's, unchanged; the English one was
 * written by this file from the language packs (`DAISY_WRITE_SNAPSHOT_EN`)
 * and reviewed: sessions created while the owner's language is English
 * get every model-facing text of the chain in English. Changing either
 * language's text means updating its snapshot on purpose.
 */
const SNAPSHOT_EN = "tests/fixtures/prompt-off-chain-base-en.json";
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const FILES = [
  "DAISY_FIXTURE_RECORD",
  "DAISY_FIXTURE_RECORD_TOOLS",
  "DAISY_FIXTURE_RECORD_THREAD",
  "DAISY_FIXTURE_ENV_FILE",
] as const;
test("switch off: launch arguments, system-layer text and every turn's text of every kind of session are the base commit's", () =>
  offChain("zh-CN", SNAPSHOT, process.env.DAISY_WRITE_SNAPSHOT));
test("switch off, English sessions: the same chain in English is the pinned English snapshot", () =>
  offChain("en", SNAPSHOT_EN, process.env.DAISY_WRITE_SNAPSHOT_EN));
async function offChain(lang: string, snapshot: string, write: string | undefined) {
  // The owner's language when the sessions are created (Daisy reads it then).
  const keptLang = process.env.DAISY_LANG;
  process.env.DAISY_LANG = lang;
  // Managed identities live outside the workspace (a read-only session
  // refuses a workspace that holds its Agent's state).
  const ids = mkdtempSync(join(tmpdir(), "daisy-off-chain-ids-"));
  process.env.DAISY_SIDECAR_BWRAP = "0";
  const h = await setup({ identityRoot: ids });
  try {
    const dir = dirname(h.record);
    const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const norm = (x: unknown): any =>
      JSON.parse(
        JSON.stringify(x)
          // P5-04: a worktree path is the realpath (macOS: /private/var/…).
          .split(realpathSync(dir))
          .join("<DIR>")
          .split(dir)
          .join("<DIR>")
          .split(ids)
          .join("<IDS>")
          .split(process.cwd())
          .join("<ROOT>")
          .replace(UUID, "<UUID>")
          .replace(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/g, "<WHEN>"),
      );
    const out: Record<string, unknown> = {};
    type Files = { record: string; thread: string; spawns: string };
    const main: Files = { record: h.record, thread: h.thread, spawns: h.spawns };
    const marks = (f: Files) => ({
      record: h.lines(f.record).length,
      thread: h.lines(f.thread).length,
      spawns: h.lines(f.spawns).length,
    });
    /** What the fake CLIs recorded while `run` ran. */
    const during = async (run: () => Promise<unknown>, f: Files = main) => {
      const at = marks(f);
      await run();
      return {
        record: h.lines(f.record).slice(at.record),
        thread: h.lines(f.thread).slice(at.thread),
        spawns: h.lines(f.spawns).slice(at.spawns),
      };
    };
    const capture = async (name: string, sid: string, agent: "claude" | "codex") => {
      const { record, thread, spawns } = await during(() =>
        h.turn(sid, "第一条：看一下当前目录。"),
      );
      out[name] =
        agent === "claude"
          ? norm({
              argv: spawns.map((x) => x.argv).find((a: string[]) => a.includes("stream-json")),
              initialize: record.find((x) => x.via === "initialize"),
              firstTurn: record.find((x) => x.via === "user")?.text,
            })
          : norm({
              argv: spawns.map((x) => x.argv).find((a: string[]) => a.includes("app-server")),
              thread: thread.find((x) => x.via === "thread/start"),
              firstTurn: record.find((x) => x.via === "turn/start")?.text,
            });
    };
    /** Everything a later turn launched and said (nothing launched = the live process). */
    const whole = (
      agent: "claude" | "codex",
      got: Awaited<ReturnType<typeof during>>,
    ) =>
      agent === "claude"
        ? {
            argv: got.spawns.map((x) => x.argv).filter((a: string[]) => a.includes("stream-json")),
            initialize: got.record.filter((x) => x.via === "initialize"),
            turns: got.record.filter((x) => x.via === "user").map((x) => x.text),
          }
        : {
            argv: got.spawns.map((x) => x.argv).filter((a: string[]) => a.includes("app-server")),
            thread: got.thread.filter((x) => String(x.via).startsWith("thread/")),
            turns: got.record.filter((x) => x.via === "turn/start").map((x) => x.text),
          };
    const ordinary: Record<string, string> = {};
    for (const agent of ["claude", "codex"] as const) {
      ordinary[agent] = (await h.create(agent, "普通会话")).id;
      await capture(`ordinary:${agent}`, ordinary[agent], agent);
    }
    for (const [k, v] of Object.entries(out)) {
      assert.ok((v as any).argv, `${k}: launch arguments captured`);
      assert.ok((v as any).firstTurn, `${k}: first-turn text captured`);
    }
    // Not the first turn: the live process, nothing launched.
    for (const agent of ["claude", "codex"] as const) {
      const got = await during(() => h.turn(ordinary[agent], "第二条：再看一眼。"));
      out[`second-turn:${agent}`] = norm(whole(agent, got));
      assert.equal((out[`second-turn:${agent}`] as any).turns.length, 1, `second-turn:${agent}`);
    }
    // The Runner restarted: the conversation is resumed in a new process.
    await h.restartRunner();
    for (const agent of ["claude", "codex"] as const) {
      const got = await during(() => h.turn(ordinary[agent], "第三条：接着来。"));
      out[`resumed:${agent}`] = norm(whole(agent, got));
      assert.equal((out[`resumed:${agent}`] as any).argv.length, 1, `resumed:${agent}: a new process`);
    }
    // Its own branch (独立分支): the workspace becomes a git repository.
    {
      const env = {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@example.invalid",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@example.invalid",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
      };
      const git = (...a: string[]) => execFileSync("git", a, { cwd: h.dir, env });
      writeFileSync(join(h.dir, ".gitignore"), "*\n!.gitignore\n!README.md\n");
      writeFileSync(join(h.dir, "README.md"), "x\n");
      git("init", "-q", "-b", "main");
      git("add", ".gitignore", "README.md");
      git("commit", "-q", "-m", "init");
    }
    const create = (agent: string, mode: string, profileId = h.profile(agent).id) =>
      h.c.request<any>("/sessions", "POST", {
        agent,
        title: mode,
        profileId,
        workspaceId: h.cat.workspaces[0].id,
        workspaceMode: mode,
      });
    for (const agent of ["claude", "codex"] as const) {
      const s = await create(agent, "isolated");
      const got = await during(() => h.turn(s.id, "第一条：看一下当前目录。"));
      const snap = await h.c.snapshot(s.id);
      assert.equal(snap.session.status, "idle", `isolated:${agent}`);
      // The branch and directory carry the session's short id.
      const short = new RegExp(esc(s.id.slice(0, 8)), "g");
      out[`isolated:${agent}`] = JSON.parse(
        JSON.stringify(norm(whole(agent, got))).replace(short, "<SID>"),
      );
      assert.equal((out[`isolated:${agent}`] as any).turns.length, 1, `isolated:${agent}`);
    }
    // Forced read-only: the engine runs in a sandbox where only its own
    // state directory can be written — so on a managed identity, with the
    // fake CLI's records kept in that directory. P5-04: only where the
    // node declares it (Linux with Bubblewrap); on macOS a forced
    // read-only session is not offered (`workspaceAccess.readOnly: false`,
    // the harness's own read-only mode instead — plan 5.14 / D-28,
    // ADR-140), so those two entries are not compared there.
    const caps: any = await until(
      () => JSON.parse(h.ctx.store.one("SELECT capabilities FROM nodes").capabilities || "{}"),
      (c: any) => c.workspaceAccess?.version >= 3,
    );
    const readOnlyHere = !!caps.workspaceAccess.readOnly;
    const nodeId = h.ctx.store.one("SELECT id FROM nodes").id as string;
    for (const agent of readOnlyHere ? (["claude", "codex"] as const) : []) {
      const p = await h.c.request<any>("/profiles", "POST", {
        nodeId,
        label: `托管 ${agent}`,
        agent,
        authMode: "subscription",
      });
      h.ctx.store.run(
        "UPDATE profiles SET data=? WHERE id=?",
        JSON.stringify({ ...p, configDir: `managed:${p.id}` }),
        p.id,
      );
      const state = managedIdentityDir(`managed:${p.id}`, p.id, (h.config as any).nodeId, ids)!;
      mkdirSync(state, { recursive: true });
      const files: Files = {
        record: join(state, "fixture-record.jsonl"),
        thread: join(state, "fixture-thread.jsonl"),
        spawns: join(state, "fixture-spawns.jsonl"),
      };
      const kept = Object.fromEntries(FILES.map((k) => [k, process.env[k]]));
      process.env.DAISY_FIXTURE_RECORD = files.record;
      process.env.DAISY_FIXTURE_RECORD_TOOLS = files.record;
      process.env.DAISY_FIXTURE_RECORD_THREAD = files.thread;
      process.env.DAISY_FIXTURE_ENV_FILE = files.spawns;
      try {
        const s = await create(agent, "read-only", p.id);
        const got = await during(() => h.turn(s.id, "第一条：看一下当前目录。"), files);
        const snap = await h.c.snapshot(s.id);
        assert.equal(snap.session.status, "idle", `read-only:${agent}`);
        out[`read-only:${agent}`] = norm(whole(agent, got));
        assert.equal((out[`read-only:${agent}`] as any).turns.length, 1, `read-only:${agent}`);
      } finally {
        for (const k of FILES) process.env[k] = kept[k];
      }
    }
    // Every audit item these turns left: which, and with which fields.
    const audits: Record<string, number> = {};
    for (const r of h.ctx.store.all("SELECT data FROM items")) {
      const d = JSON.parse(r.data);
      if (d.category !== "audit") continue;
      const k = `${d.name} {${Object.keys(d.input || {}).sort().join(",")}}`;
      audits[k] = (audits[k] || 0) + 1;
    }
    out["audit-items"] = audits;
    // The node's state sync answer (P1-02: was the heartbeat's; `release`
    // went with it): its fields (asked by hand, last — it overwrites what
    // the Runner said of itself).
    const beat = await h.config.api("/sync", { capabilities: {} });
    out["sync-fields"] = Object.keys(beat as object).sort();
    if (write) {
      writeFileSync(write, JSON.stringify(out, null, 2) + "\n");
      return;
    }
    assert.ok(existsSync(snapshot), "the base snapshot is checked in");
    const base = JSON.parse(readFileSync(snapshot, "utf8"));
    // The English snapshot was written on macOS (no read-only entries):
    // where they are measured, they are compared in Chinese only.
    // The sent-content audit's name in either language (P6-25: the English one too — on Linux
    // the English run has read-only entries the macOS-made English snapshot does not).
    const SENT_AUDIT = new Set(Object.values(shippedPacks()).map((p) => p["server-turns.audit.sent"]).filter(Boolean));
    const sentKey = (x: any) => {
      const k = Object.keys(x["audit-items"]).find((k) => SENT_AUDIT.has(k.slice(0, k.indexOf(" {"))));
      assert.ok(k, "a sent-content audit item is there");
      return k;
    };
    if (readOnlyHere && !Object.keys(base).some((k) => k.startsWith("read-only:"))) {
      for (const k of Object.keys(out)) if (k.startsWith("read-only:")) delete out[k];
      (out["audit-items"] as any)[sentKey(out)] -= 2;
    }
    if (!readOnlyHere && Object.keys(base).some((k) => k.startsWith("read-only:"))) {
      for (const k of Object.keys(base)) if (k.startsWith("read-only:")) delete base[k];
      // Each of the two read-only turns (one per engine) left one 发送内容审计.
      base["audit-items"][sentKey(base)] -= 2;
    }
    assert.deepEqual(Object.keys(out).sort(), Object.keys(base).sort());
    for (const k of Object.keys(base)) assert.deepEqual(out[k], base[k], k);
  } finally {
    await h.close();
    delete process.env.DAISY_SIDECAR_BWRAP;
    rmSync(ids, { recursive: true, force: true });
    if (keptLang === undefined) delete process.env.DAISY_LANG;
    else process.env.DAISY_LANG = keptLang;
  }
}
