import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  freshLaunch,
  launchGuide,
  launchGuideKey,
  layeredGuide,
  staticRulesDelivered,
  toolsFor,
  toolsNote,
} from "../packages/daisy/src/tools/daisy-tools.ts";
import { daisyToolNames } from "../packages/contracts/src/native-tools.ts";
import { localTimeZone, zoneName } from "../packages/contracts/src/scheduler.ts";
/**
 * ADR-154 (P6-04): the only edits to the 74a2714 texts — the product name
 * the model reads, and the resident's time section names the machine's
 * zone instead of Beijing time. A job from a control plane before
 * ADR-154 (`harborTools`) still names the tools `harbor_*` /
 * `mcp__harbor__*`: those are what that Runner serves.
 *
 * P6-14 (ADR-157 § P6-14) edited the snapshot by hand for one line: the
 * resident's 「审批一次提全」 no longer names a plugin's ticket kind next to
 * the approval card (now 「合并成一张审批单，不要做一步问一步。」, in the four
 * resident entries). Nothing else in it changed.
 */
const renamed = (t: string) =>
  t
    .replace("【Harbor 定时与后台】", "【Daisy 定时与后台】")
    .replace(/这些由 Harbor 保存/g, "这些由 Daisy 保存")
    .replace("你是 Harbor 的「任务常驻 Agent」", "你是 Daisy 的「任务常驻 Agent」")
    .replace("你现在是 Harbor 的「只问」只读支线", "你现在是 Daisy 的「只问」只读支线")
    .replace(
      "（周期，按服务器时区；主人在设置里看到的是北京时间和 UTC）",
      `（周期，按服务器所在时区 ${zoneName(localTimeZone())}）`,
    );
const sha16 = (t: string) => createHash("sha256").update(t).digest("hex").slice(0, 16);
import { setLiveSettings } from "../packages/daisy/src/harness/shared.ts";
import {
  readOnlyNote,
  sharedWorkspaceNote,
} from "../packages/daisy/src/prompts/collab-guide.ts";
import { sidecarGuideNote, sidecarGuide } from "../packages/daisy/src/turns/sidecar.ts";
import { liveKey } from "../packages/daisy/src/turns/live.ts";
import { instructionFiles } from "../packages/daisy/src/observe/launch-audit.ts";
import {
  GUIDE_LIMITS,
  ORG_READ_REASON_KEY,
} from "../packages/contracts/src/guide.ts";
import { hash as serverHash } from "../packages/daisy/src/store/index.ts";
import { safetyText } from "../packages/contracts/src/resident-prompt.ts";
import "../packages/contracts/src/i18n-node.ts";
import { promptT } from "../packages/contracts/src/prompt-i18n.ts";
const ZH = promptT("zh-CN");
/**
 * The layered prompt, Runner side (P4-13: reading the org core is a
 * plugin's job, tested with that plugin): what a process is launched with
 * and keyed on with and without the control plane's `guide`, and the
 * per-turn line. No org platform is read here.
 */
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const CORE = "◬ T\n\n## 规则\n\n### 会话开始\n\nx\n\n### 红线\n\n1. y\n";
const tmp = () => mkdtempSync(join(tmpdir(), "daisy-org-guide-"));

const guide = (over: any = {}) => ({
  v: 2 as const,
  text: "【组织启动核心 · Harbor 注入 · SYS-x v1】\n…\n\n" + safetyText(ZH),
  sha256: "a".repeat(64),
  stable: "stable-1",
  org: null,
  layers: [],
  staticRules: true,
  fresh: true,
  ...over,
});
const job = (session: any = {}, over: any = {}): any => ({
  id: "j1",
  daisyTools: { version: 2 },
  session: { id: "s1", agent: "claude", nativeId: null, ...session },
  profile: { id: "p1", authMode: "subscription" },
  workspace: { path: "/tmp" },
  ...over,
});

test("P4N-3: the tool names the control plane composes with are the ones the Runner gives (ordinary and resident)", () => {
  for (const kind of [undefined, "resident"] as const)
    assert.deepEqual(
      toolsFor(job({ kind })).map((t) => t.name),
      daisyToolNames(kind),
    );
});

test("without a guide everything is what 74a2714 sent, byte for byte (snapshot generated from that commit)", () => {
  const snap = JSON.parse(
    readFileSync("tests/fixtures/prompt-legacy-74a2714.json", "utf8"),
  );
  const FEATS = ["threads", "needs-reply", "approvals", "quotes", "ask-only", "mention-reply"];
  for (const agent of ["claude", "codex"]) {
    // ADR-154: by the old names (as a Runner before it serves them) — the
    // 74a2714 text but for the product name; by Daisy's names otherwise.
    assert.equal(toolsNote(agent, "legacy"), renamed(snap.toolsNote[agent]));
    assert.equal(
      toolsNote(agent),
      renamed(snap.toolsNote[agent]).replace(/mcp__harbor__|harbor_/g, (m) =>
        m === "harbor_" ? "daisy_" : "mcp__daisy__",
      ),
    );
  }
  assert.equal(sharedWorkspaceNote(ZH), snap.sharedWorkspace);
  assert.equal(readOnlyNote(ZH), snap.readOnly);
  assert.equal(sidecarGuideNote({} as any), renamed(snap.sidecarGuide));
  assert.equal(safetyText(ZH), snap.safety);
  // P1-01: the 群聊 CLI note (snap.collabGuide) is gone with the CLI.
  const res = (agent: string, prompt?: any) => ({
    id: "s",
    agent,
    nativeId: null,
    kind: "resident",
    task: { id: "T-1", title: "修构建" },
    resident: {
      purpose: "盯紧夜间构建",
      scope: { tasks: "bound" },
      tasks: [{ id: "T-1", title: "修构建" }],
      maxTurnMinutes: 30,
      dailyTurns: 5,
      ...(prompt ? { prompt } : {}),
    },
  });
  const PROMPT = {
    overrides: { say: "少说话。", wake: "先看原因。" },
    custom: [{ id: "a", title: "习惯", text: "结论写进任务记录。" }],
    updatedAt: 1,
    updatedBy: "u",
  };
  const j = (session: any, extra: any = {}): any => ({
    id: "j",
    harborTools: { version: 1 },
    session,
    profile: { id: "p", authMode: "subscription" },
    ...extra,
  });
  for (const agent of ["claude", "codex"]) {
    assert.equal(launchGuide(j({ id: "s", agent, nativeId: null })), renamed(snap.launch[`ordinary:${agent}`]));
    // P1-01: a resident's scope no longer names 群 (its line is gone).
    const noGroups = (t: string) => t.replace(/可参与的群：[^\n]*\n/, "");
    assert.equal(launchGuide(j(res(agent))), renamed(noGroups(snap.launch[`resident:${agent}`])));
    assert.equal(launchGuide(j(res(agent, PROMPT))), renamed(noGroups(snap.launch[`resident-edited:${agent}`])));
    // The process key too: updating the Runner restarts nothing — except
    // that P4-08 (ADR-127) added three Daisy tools (the A2A client), so the
    // tool count in the key is 3 more: a process started before gets them
    // only by restarting (Claude lists its tools at start).
    const plusA2A = (k: string) => k.replace(/,(\d+),("[0-9a-f]{16}"\])$/, (_m, n, h) => `,${Number(n) + 3},${h}`);
    // ADR-154: the key holds the launch text's hash — the renamed text's
    // now (the old one was the 74a2714 text's: checked first).
    const ordinary = snap.launch[`ordinary:${agent}`];
    assert.ok(snap.liveKey[`ordinary:${agent}`].endsWith(`"${sha16(ordinary)}"]`));
    assert.equal(
      liveKey(j({ id: "s", agent, nativeId: null }), "/w"),
      plusA2A(snap.liveKey[`ordinary:${agent}`]).replace(sha16(ordinary), sha16(renamed(ordinary))),
    );
    assert.equal(
      liveKey(j(res(agent, PROMPT), { residentGuide: "控制面写的" }), "/w"),
      plusA2A(snap.liveKey[`resident-guide:${agent}`]),
    );
  }
});

test("launch text: the control plane's guide as is; without it the older logic, byte for byte", () => {
  // No `guide` (an older control plane, or the layers off): as before.
  assert.equal(launchGuide(job()), toolsNote("claude").trim());
  assert.match(launchGuide(job()), /^【Daisy 定时与后台】要过一会儿再继续/);
  assert.equal(launchGuide(job({}, { daisyTools: undefined })), "");
  // ADR-154: by the names the control plane says — the old ones for a
  // conversation started with them, or from a control plane before it.
  assert.equal(
    launchGuide(job({}, { daisyTools: { version: 2, legacyNames: true } })),
    toolsNote("claude", "legacy").trim(),
  );
  assert.equal(
    launchGuide(job({}, { daisyTools: undefined, harborTools: { version: 1 } })),
    toolsNote("claude", "legacy").trim(),
  );
  assert.match(toolsNote("claude", "legacy"), /mcp__harbor__wakeup/);
  // P4N-3: a Codex thread without Daisy's tools — no timers note, but the
  // line on the tools it lacks; one started before the A2A tools: both.
  const bare = launchGuide(job({ agent: "codex", nativeId: "t1", nativeTools: { thread: "t0", version: 1 } }));
  assert.match(bare, /^【这段对话缺少的 Daisy 工具】.*daisy_wakeup/);
  assert.ok(!bare.includes("【Daisy 定时与后台】"));
  const older = launchGuide(
    job({ agent: "codex", nativeId: "t1", nativeTools: { thread: "t1", version: 1, names: ["wakeup", "cron", "bash", "monitor", "output", "schedules", "cancel"] } }),
  );
  assert.ok(older.startsWith(toolsNote("codex").trim()));
  assert.match(older, /\n\n【这段对话缺少的 Daisy 工具】.*：daisy_agents、daisy_call_agent、daisy_call_result。/);
  assert.equal(
    launchGuide(job({ agent: "codex", nativeId: "t1", nativeTools: { thread: "t1", version: 1, names: toolsFor(job()).map((t) => t.name) } })),
    toolsNote("codex").trim(),
  );
  const resident = job({ kind: "resident", resident: { purpose: "p", scope: { groups: "all", tasks: "bound" } } });
  assert.ok(launchGuide(resident).endsWith(safetyText(ZH)));
  assert.equal(launchGuide({ ...resident, residentGuide: "控制面写的" }), "控制面写的");
  // With `guide`: its text, whatever else the job says.
  const g = guide();
  assert.equal(launchGuide({ ...job(), guide: g }), g.text);
  assert.equal(launchGuide({ ...resident, residentGuide: "控制面写的", guide: g }), g.text);
  // Not a guide this Runner knows (another version, no text): the older logic.
  assert.equal(layeredGuide({ guide: { ...g, v: 3 } as any }), null);
  assert.equal(launchGuide({ ...job(), guide: { ...g, text: " " } }), toolsNote("claude").trim());
  // A sidecar: the guide when sent, else its one note.
  assert.equal(sidecarGuide({} as any), sidecarGuideNote({} as any));
  assert.equal(sidecarGuide({ guide: g } as any), g.text);
});

test("process key: `guide.stable` — a changed core alone does not restart; without a guide the text itself", () => {
  const a = { ...job(), guide: guide() },
    newCore = { ...job(), guide: guide({ text: "另一版核心……" + safetyText(ZH), sha256: "b".repeat(64) }) },
    edited = { ...job(), guide: guide({ stable: "stable-2" }) };
  assert.equal(launchGuideKey(a), "g2:stable-1");
  assert.equal(liveKey(a, "/w"), liveKey(newCore, "/w"));
  assert.notEqual(liveKey(a, "/w"), liveKey(edited, "/w"));
  // The control plane starts (or stops) sending a guide: one restart.
  assert.notEqual(liveKey(a, "/w"), liveKey(job(), "/w"));
  // Without a guide the key follows the text, as it did.
  const r1 = job({ kind: "resident", resident: { purpose: "p", scope: { groups: "all", tasks: "bound" } } });
  assert.notEqual(
    liveKey({ ...r1, residentGuide: "一" }, "/w"),
    liveKey({ ...r1, residentGuide: "二" }, "/w"),
  );
});

test("each turn: one command line only where the system layer is known to hold the rules — never neither", () => {
  // P1-01: the 群聊 CLI's per-turn line and note are gone; the workspace
  // notes stay.
  assert.equal(sharedWorkspaceNote(ZH), "\n同一工作区可能有其他会话在并行：改同一文件前先协调；独立的改动用独立 Git worktree，临时文件放 TMPDIR；要并行改代码就请本人另开独立开发会话，由任务负责人合入。");
  assert.equal(readOnlyNote(ZH), "\n本会话为强制只读分析，源文件不可写；临时文件请使用 TMPDIR。需要改代码时由主人创建独立开发会话。");
  const g = guide();
  // No guide, or the rules not moved up: the full note.
  assert.equal(staticRulesDelivered(job()), false);
  assert.equal(staticRulesDelivered({ ...job(), guide: guide({ staticRules: false }) }), false);
  // A new native session is launched with this text: short.
  assert.equal(staticRulesDelivered({ ...job(), guide: g }), true);
  // A resumed one the Runner never reported the layered prompt for (an
  // older Claude session keeps its recorded system prompt, a Codex thread
  // its first developer instructions): the full note stays.
  assert.equal(staticRulesDelivered({ ...job({ nativeId: "n1" }), guide: g }), false);
  const has = (nativeGuide: any, over: any = {}, guide: any = g) =>
    staticRulesDelivered({ ...job({ nativeId: "n1", nativeGuide, ...over }), guide });
  assert.equal(
    has({ thread: "n0", sha256: "x", staticRules: true, via: "record", at: 1 }),
    false,
    "reported for another native session (after /clear)",
  );
  assert.equal(
    has({ thread: "n1", sha256: "x", staticRules: false, via: "record", at: 1 }),
    false,
    "the text it has was composed without the static rules",
  );
  // Recorded by the engine, or injected into the thread (an older text is
  // fine — it holds the rules): short.
  assert.equal(has({ thread: "n1", sha256: "older", staticRules: true, via: "record", at: 1 }), true);
  assert.equal(
    has({ thread: "n1", sha256: "older", staticRules: true, via: "inject", at: 1 }, { agent: "codex" }),
    true,
  );
  // Rendered afresh at that launch: holds only while launches still are.
  // The experiment switched off (or a CLI it was not measured on) and the
  // session is back on what the engine recorded before — the full note.
  const fresh = { thread: "n1", sha256: "x", staticRules: true, via: "fresh", at: 1 };
  assert.equal(has(fresh, {}, guide({ fresh: false })), false, "fresh switched off");
  assert.equal(has(fresh, {}, guide({ fresh: true })), false, "no measured CLI version here");
  assert.equal(freshLaunch({ ...job(), guide: guide({ fresh: true }) }), false);
  setLiveSettings({ claude: { cliVersion: "2.1.322 (Claude Code)" } });
  try {
    assert.equal(freshLaunch({ ...job(), guide: guide({ fresh: true }) }), true);
    assert.equal(freshLaunch({ ...job(), guide: guide({ fresh: false }) }), false);
    assert.equal(freshLaunch({ ...job({ agent: "codex" }), guide: guide({ fresh: true }) }), false);
    assert.equal(has(fresh, {}, guide({ fresh: true })), true);
    assert.equal(has(fresh, {}, guide({ fresh: false })), false);
  } finally {
    setLiveSettings(null);
  }
  // How it got there unknown (a record from before `via`): not assumed.
  assert.equal(has({ thread: "n1", sha256: "x", staticRules: true, at: 1 }), false);
});

test("launch audit: the engine's own instruction files from the workspace up to home", () => {
  const home = tmp(),
    repo = join(home, "code", "repo"),
    deep = join(repo, "packages", "x");
  mkdirSync(deep, { recursive: true });
  writeFileSync(join(home, "CLAUDE.md"), "home core");
  writeFileSync(join(home, "AGENTS.md"), "home core");
  writeFileSync(join(repo, "CLAUDE.md"), "repo rules");
  const files = instructionFiles("claude", deep, home);
  assert.deepEqual(
    files.map((f) => f.path),
    [join(repo, "CLAUDE.md"), join(home, "CLAUDE.md")],
  );
  assert.equal(files[1].sha256, sha("home core"));
  assert.equal(files[1].bytes, 9);
  assert.deepEqual(
    instructionFiles("codex", deep, home).map((f) => f.path),
    [join(home, "AGENTS.md")],
  );
  // A workspace outside home: its own, and home's (listed, not assumed loaded).
  const out = tmp();
  writeFileSync(join(out, "AGENTS.md"), "x");
  assert.deepEqual(
    instructionFiles("codex", out, home).map((f) => f.path),
    [join(out, "AGENTS.md"), join(home, "AGENTS.md")],
  );
  assert.equal(existsSync(join(out, "CLAUDE.md")), false);
});
