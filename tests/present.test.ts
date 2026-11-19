import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  safeHostHref,
  daisyPhaseTone,
  daisyTimeFormat,
  backgroundKind,
  hasOutput,
} from "../packages/ui/src/present.ts";
import {
  stepLine,
  stepPhrase,
  elapsedText,
  agoText,
  groupTurns,
  currentTurnIndex,
  turnEnd,
} from "../packages/ui/src/present.ts";
import { inUiLang, uiLang } from "./ui-pack.ts";

// ADR-159 §8: the UI speaks Chinese in these assertions.
uiLang("zh-CN");

test("host links: http(s) only, same-origin or DAISY_ORIGINS", () => {
  const here = "https://host.example.com/daisy/?s=1";
  // Relative paths resolve against the page origin (not the /daisy/ path).
  assert.equal(safeHostHref("/", here), "https://host.example.com/");
  assert.equal(
    safeHostHref("/tasks/T-1?tab=ai#x", here),
    "https://host.example.com/tasks/T-1?tab=ai#x",
  );
  assert.equal(
    safeHostHref("https://host.example.com/tasks/T-1", here),
    "https://host.example.com/tasks/T-1",
  );
  // Other origins only when listed.
  assert.equal(safeHostHref("https://evil.example/", here), null);
  assert.equal(
    safeHostHref("https://ui.example.com/t/1", here, [
      "https://ui.example.com",
    ]),
    "https://ui.example.com/t/1",
  );
  assert.equal(
    safeHostHref("http://host.example.com/", here),
    null,
    "scheme change is another origin",
  );
  for (const bad of [
    "javascript:alert(1)",
    "JAVASCRIPT:alert(1)",
    " javascript:alert(1)",
    "data:text/html,<script>1</script>",
    "vbscript:x",
    "//evil.example/",
    "/\\evil.example/",
    "https://host.example.com\\@evil.example/",
    "https://user:pw@host.example.com/",
    "/a\nb",
    "",
    "   ",
    undefined,
    null,
  ])
    assert.equal(safeHostHref(bad as any, here), null, String(bad));
  assert.equal(safeHostHref("/", "not a url"), null);
});

test("status tones: completed green, interrupted/idle neutral, failed red, waiting amber, running accent", () => {
  assert.equal(daisyPhaseTone("completed"), "success");
  assert.equal(daisyPhaseTone("interrupted"), "neutral");
  assert.equal(daisyPhaseTone("idle"), "neutral");
  assert.equal(daisyPhaseTone("failed"), "danger");
  assert.equal(daisyPhaseTone("awaiting-authorization"), "warning");
  assert.equal(daisyPhaseTone("running"), "accent");
  assert.equal(daisyPhaseTone("queued"), "accent");
});

test("times follow branding lang; Chinese defaults to a 24-hour clock", () => {
  const ts = new Date(2026, 9, 10, 15, 42).getTime();
  const zh = daisyTimeFormat({ locale: "zh-CN" }, "en-US");
  assert.match(zh.time(ts), /^15:42$/);
  assert.match(zh.date(ts), /^2026\/10\/10$/);
  // Browser locale fallback (no branding lang): en-US keeps its 12-hour clock.
  assert.match(daisyTimeFormat({}, "en-US").time(ts), /PM/);
  // A Chinese browser without branding lang still gets 24-hour.
  assert.doesNotMatch(daisyTimeFormat({}, "zh-CN").time(ts), /PM|下午/);
  // Explicit hour12 wins either way.
  assert.match(
    daisyTimeFormat({ locale: "en-US", hour12: false }).time(ts),
    /^15:42$/,
  );
  assert.match(
    daisyTimeFormat({ locale: "zh-CN", hour12: true }).time(ts),
    /下午|PM/,
  );
});

test("turnActions: tool calls and their authorizations become one readable line each", async () => {
  const { turnActions, commandOf, fillCopy } =
    await import("../packages/ui/src/present.ts");
  // Same strings as defaultDaisyCopy (host.tsx imports react-native).
  const c = {
    traceRanCommand: "运行了 {command}",
    traceWantedCommand: "想运行 {command}",
    traceToolDetail: "{tool}：{detail}",
    traceApprovalNote: "（{option}）",
    traceApprovalDenied: "（你拒绝了）",
    traceApprovalExpired: "（授权已过期）",
  };
  const name = (t: any) => t.name || "工具";
  const allow = (input: unknown, title = "Bash") => ({
    title,
    input,
    status: "answered",
    options: [
      { id: "allow", label: "允许本次" },
      { id: "deny", label: "拒绝" },
    ],
    decision: { optionId: "allow" },
  });
  assert.equal(commandOf({ command: "  ls   -la " }), "ls -la");
  assert.equal(commandOf({ command: ["git", "status"] }), "git status");
  assert.equal(commandOf({ file_path: "/a" }), "");
  assert.equal(fillCopy("a {x} {y}", { x: 1 }), "a 1 {y}");
  // A named tool and its authorization: one line, not two.
  assert.deepEqual(
    turnActions(
      [{ name: "Bash", input: { command: "pwd" } }],
      [allow({ command: "pwd" })],
      c,
      name,
    ),
    ["运行了 pwd（允许本次）"],
  );
  // An unnamed tool result (no name / input) pairs with the authorization.
  assert.deepEqual(turnActions([{}], [allow({ command: "pwd" })], c, name), [
    "运行了 pwd（允许本次）",
  ]);
  // Unnamed tool without authorization: nothing to say about it.
  assert.deepEqual(turnActions([{}], [], c, name), []);
  // File tools show what they touched; refusals and expiry read differently.
  assert.deepEqual(
    turnActions(
      [
        { name: "Read", input: { file_path: "/w/README.md" } },
        { name: "Bash", input: { command: "rm -rf build" } },
      ],
      [
        {
          ...allow({ command: "rm -rf build" }),
          decision: { optionId: "deny" },
        },
        {
          ...allow({ command: "make" }),
          status: "expired",
          decision: undefined,
        },
      ],
      c,
      name,
    ),
    [
      "Read：/w/README.md",
      "想运行 rm -rf build（你拒绝了）",
      "想运行 make（授权已过期）",
    ],
  );
});

test("trace bar line: step number, what, how long; stages before the first step", () => {
  const at = 1_000_000;
  const item = (id: string, patch: any) => ({
    id: `j:${id}`,
    kind: "tool" as const,
    text: "",
    createdAt: at,
    ...patch,
  });
  const steps = [
    item("stage:claimed", {
      category: "lifecycle",
      name: "执行节点已接单",
      status: "complete",
    }),
    item("t1", {
      name: "Read",
      input: { file_path: "/w/src/chat.tsx" },
      status: "complete",
    }),
    item("t2", { kind: "thinking", status: "complete" }),
    item("t3", {
      name: "Bash",
      input: { command: "npm   test" },
      status: "running",
      createdAt: at - 42_000,
    }),
  ];
  assert.equal(stepLine(steps, at), "第 3 步 · 正在运行 npm test · 42 秒");
  steps[3].status = "complete";
  assert.equal(
    stepLine(steps, at),
    "第 3 步完成：运行 npm test · 正在想下一步",
  );
  assert.equal(
    stepLine(steps, at, { streaming: true }),
    "已完成 3 步 · 正在写回复",
  );
  assert.equal(stepLine(steps.slice(0, 1), at), "执行节点已接单…");
  assert.equal(stepPhrase(steps[1]), "读取 chat.tsx");
  assert.equal(
    stepPhrase(item("g", { name: "Grep", input: { pattern: "contextFill" } })),
    "搜索 “contextFill”",
  );
  assert.equal(
    stepPhrase(
      item("w", { name: "WebFetch", input: { url: "https://example.com/a" } }),
    ),
    "读取网页 example.com",
  );
  assert.equal(elapsedText(185_000), "3 分 05 秒");
  assert.equal(agoText(30_000), "刚刚");
  assert.equal(agoText(3 * 60_000), "3 分钟前");
});

test("turns: user / Agent-started markers start turns, a job's late items stay with it, an operation is its own turn", () => {
  const J1 = "11111111-1111-4111-8111-111111111111",
    J2 = "22222222-2222-4222-8222-222222222222",
    W = "33333333-3333-4333-8333-333333333333",
    OP = "44444444-4444-4444-8444-444444444444";
  const it = (id: string, kind = "tool", category?: string) => ({
    id,
    kind,
    ...(category ? { category } : {}),
  });
  const turns = groupTurns([
    it(`user:${J1}`, "user"),
    it(`${J1}:a`, "assistant"),
    it(`user:${J2}`, "user"), // queued while J1 runs
    it(`${J1}:late`), // J1 still working: stays in J1's turn
    it(`${J2}:b`, "assistant"),
    it(`wake:${W}`, "notice", "wake"),
    it(`${W}:c`, "assistant"),
    it(`${J1}:task:bg`), // finished between turns: still J1's
    it(`${OP}:stage:operation`),
    it(`${OP}:compact:x`, "notice", "compact"),
    it("input:m1", "user"), // steer into the running op? stays ordered
    it(`${OP}:after`),
  ]);
  assert.deepEqual(
    turns.map((t) => t.map((x) => x.id)),
    [
      [`user:${J1}`, `${J1}:a`, `${J1}:late`, `${J1}:task:bg`],
      [`user:${J2}`, `${J2}:b`],
      [`wake:${W}`, `${W}:c`],
      [`${OP}:stage:operation`, `${OP}:compact:x`],
      ["input:m1", `${OP}:after`],
    ],
  );
});

test("background items are named by what they are", () => {
  assert.deepEqual(backgroundKind({ kind: "task", type: "local_bash" }), {
    icon: "▣",
    kind: "后台命令",
  });
  assert.equal(
    backgroundKind({ kind: "task", type: "monitor_mcp" }).kind,
    "监视",
  );
  assert.equal(
    backgroundKind({ kind: "task", type: "local_agent" }).kind,
    "子 Agent",
  );
  assert.equal(backgroundKind({ kind: "task" }).kind, "后台任务");
  assert.equal(backgroundKind({ kind: "wakeup" }).kind, "定时器");
  assert.equal(backgroundKind({ kind: "cron" }).kind, "定时任务");
  assert.ok(hasOutput({ type: "monitor_ws" }));
  assert.ok(!hasOutput({ type: "local_agent" }));
});

test("trace bar follows the running turn, not queued messages behind it", () => {
  const J1 = "11111111-1111-4111-8111-111111111111",
    J2 = "22222222-2222-4222-8222-222222222222",
    J3 = "33333333-3333-4333-8333-333333333333";
  const at = 1_000_000;
  const items = [
    { id: `user:${J1}`, kind: "user", status: "accepted", createdAt: at },
    {
      id: `${J1}:t1`,
      kind: "tool",
      name: "Read",
      status: "complete",
      createdAt: at + 1000,
    },
    { id: `user:${J2}`, kind: "user", status: "queued", createdAt: at + 2000 },
    { id: `user:${J3}`, kind: "user", status: "queued", createdAt: at + 3000 },
    {
      id: `${J1}:t2`,
      kind: "tool",
      name: "Bash",
      input: { command: "npm test" },
      status: "running",
      createdAt: at + 4000,
    },
  ] as unknown as Parameters<typeof stepLine>[0];
  const turns = groupTurns(items);
  assert.equal(turns.length, 3);
  const queued = new Set([`user:${J2}`, `user:${J3}`]);
  // Before the fix the trace bar read the last turn: a queued message, no steps.
  assert.equal(
    stepLine(
      turns.at(-1)!.filter((x) => x.kind === "tool"),
      at + 46_000,
    ),
    "正在准备…",
  );
  const i = currentTurnIndex(turns, (id) => queued.has(id));
  assert.equal(i, 0);
  const activity = turns[i].filter(
    (x) => x.kind === "tool" || x.kind === "thinking",
  );
  assert.match(stepLine(activity, at + 46_000), /^第 2 步 · 正在.* · 42 秒$/);
  // No queue: the last turn, as before.
  assert.equal(
    currentTurnIndex(turns, () => false),
    2,
  );
  // A queued message that has started (accepted) is the current turn.
  const started = groupTurns(
    items.map((x) =>
      x.id === `user:${J3}` ? { ...x, status: "accepted" } : x,
    ),
  );
  assert.equal(
    currentTurnIndex(started, (id) => queued.has(id)),
    2,
  );
  assert.equal(
    currentTurnIndex([], () => true),
    -1,
  );
});

test("the trace follows the running job whatever is queued behind it — group requests, cron wakes, removed messages", () => {
  // Reported 2026-11-05: 「有多条积压的时候就又出现执行轨迹不显示」
  // 「常驻会话里cron到达以后，执行轨迹会被清空」
  const R = "11111111-1111-4111-8111-111111111111",
    U = "22222222-2222-4222-8222-222222222222",
    C = "33333333-3333-4333-8333-333333333333",
    W = "44444444-4444-4444-8444-444444444444",
    X = "55555555-5555-4555-8555-555555555555";
  const at = 1_000_000;
  const items = [
    { id: `user:${R}`, kind: "user", status: "accepted", createdAt: at },
    {
      id: `${R}:t1`,
      kind: "tool",
      name: "Bash",
      input: { command: "npm test" },
      status: "running",
      createdAt: at + 1000,
    },
    // The owner's queued message, a group request, a cron wake, a message
    // removed from the queue — all behind the running turn.
    { id: `user:${U}`, kind: "user", status: "queued", createdAt: at + 2000 },
    {
      id: `user:${C}`,
      kind: "user",
      status: "queued",
      origin: { type: "peer" },
      createdAt: at + 3000,
    },
    {
      id: `wake:${W}`,
      kind: "notice",
      category: "wake",
      status: "complete",
      text: "定时任务：每小时巡检",
      createdAt: at + 4000,
    },
    {
      id: `user:${X}`,
      kind: "user",
      status: "cancelled",
      createdAt: at + 5000,
    },
  ] as unknown as Parameters<typeof stepLine>[0];
  const pending = new Set([`user:${U}`, `user:${C}`, `wake:${W}`]);
  const waiting = (id: string) => pending.has(id);
  const turns = groupTurns(items, waiting);
  assert.equal(turns.length, 5);
  const i = currentTurnIndex(turns, waiting);
  assert.equal(i, 0, "the running turn, not the wake / group request");
  assert.match(
    stepLine(
      turns[i].filter((x) => x.kind === "tool"),
      at + 43_000,
    ),
    /^第 1 步 · 正在.* · 42 秒$/,
  );
  // The wake starts (no longer queued): it is the current turn.
  pending.delete(`wake:${W}`);
  pending.delete(`user:${U}`);
  pending.delete(`user:${C}`);
  assert.equal(currentTurnIndex(turns, waiting), 3);
  // A turn with steps of its own has begun even if the queue view is stale.
  const stale = groupTurns([
    ...items.slice(0, 3),
    {
      id: `${U}:t1`,
      kind: "tool",
      status: "running",
      createdAt: at + 6000,
    },
  ] as any);
  assert.equal(
    currentTurnIndex(stale, (id) => id === `user:${U}`),
    1,
  );
  // 立即追加 while messages wait: it joins the running job, not a queued one.
  const steered = groupTurns(
    [
      ...items.slice(0, 4),
      {
        id: "input:m1",
        kind: "user",
        status: "accepted",
        createdAt: at + 7000,
      },
      {
        id: `${R}:t2`,
        kind: "tool",
        status: "running",
        createdAt: at + 8000,
      },
    ] as any,
    (id) => id === `user:${U}` || id === `user:${C}`,
  );
  const cur = currentTurnIndex(steered, (id) =>
    [`user:${U}`, `user:${C}`].includes(id),
  );
  assert.deepEqual(
    steered[cur].map((x) => x.id),
    ["input:m1", `${R}:t2`],
  );
});

test("a wake removed from the queue (cancelled) never started: the trace stays on the running turn", () => {
  const R = "11111111-1111-4111-8111-111111111111",
    M = "66666666-6666-4666-8666-666666666666",
    K = "77777777-7777-4777-8777-777777777777";
  const items = [
    { id: `user:${R}`, kind: "user", status: "accepted", createdAt: 1 },
    { id: `${R}:t1`, kind: "tool", status: "running", createdAt: 2 },
    {
      id: `wake:${M}`,
      kind: "notice",
      category: "wake",
      status: "cancelled",
      text: "后台任务结束（不会送达）",
      createdAt: 3,
    },
    {
      id: `wake:${K}`,
      kind: "notice",
      category: "wake",
      status: "cancelled",
      text: "外部回调（不会送达）",
      createdAt: 4,
    },
  ] as any;
  const turns = groupTurns(items, () => false);
  assert.equal(
    currentTurnIndex(turns, () => false),
    0,
  );
});

test("userStatusText (follow-up 2026-11-09): an appended / steered message says handed over vs read; older servers keep 「已接收」", async () => {
  const { userStatusText } = await import("../packages/ui/src/present.ts");
  // P6-22: the default copy is the language pack's `ui-copy.*`.
  const { uiMessages } = await import("./ui-pack.ts");
  const zh = uiMessages("zh-CN");
  const word = (k: string) => zh[`ui-copy.${k}`] ?? "";
  const keys = [
    "userStatusQueued",
    "userStatusSent",
    "userStatusAccepted",
    "userStatusHanded",
    "userStatusRead",
    "userStatusError",
    "userStatusCancelled",
    "userStatusRequeued",
    "userStatusAppended",
  ] as const;
  const copy = Object.fromEntries(keys.map((k) => [k, word(k)])) as any;
  assert.equal(copy.userStatusHanded, "已交给 Agent，到下一个工具边界读取");
  assert.equal(copy.userStatusRead, "Agent 已读取");
  assert.equal(
    userStatusText({ status: "accepted", delivery: "handed" }, copy),
    "已交给 Agent，到下一个工具边界读取",
  );
  assert.equal(
    userStatusText({ status: "accepted", delivery: "read" }, copy),
    "Agent 已读取",
  );
  assert.equal(userStatusText({ status: "accepted" }, copy), "Agent 已接收");
  assert.equal(
    userStatusText({ status: "appended" }, copy),
    "已追加，等待 AI 读取",
  );
  assert.equal(userStatusText({ status: "queued" }, copy, true), "等待发送");
  assert.equal(userStatusText({ status: "queued" }, copy), "已发送");
  assert.equal(userStatusText({ status: "odd" }, copy), "odd");
});

test("N-3: stopping a turn marks only that turn 「已中断」; earlier turns keep their own end", () => {
  const A = "11111111-1111-4111-8111-111111111111",
    B = "22222222-2222-4222-8222-222222222222",
    C = "33333333-3333-4333-8333-333333333333";
  const items = [
    { id: `user:${A}`, kind: "user", status: "accepted" },
    { id: `${A}:t1`, kind: "tool", status: "complete" },
    { id: `user:${B}`, kind: "user", status: "accepted" },
    { id: `${B}:t1`, kind: "tool", status: "running" },
    // The server's end line of a stopped job (queue.ts settleJob).
    { id: `${B}:turn-end`, kind: "notice", status: "interrupted", text: "本轮已停止" },
    { id: `user:${C}`, kind: "user", status: "accepted" },
    { id: `${C}:t1`, kind: "tool", status: "complete" },
  ] as any[];
  const turns = groupTurns(items, () => false);
  assert.equal(turns.length, 3);
  // Session interrupted right after B: only B (the current turn) says so.
  const atStop = groupTurns(items.slice(0, 5), () => false);
  const live = currentTurnIndex(atStop, () => false);
  assert.deepEqual(
    atStop.map((t, i) => turnEnd(t, i === live ? "interrupted" : undefined)),
    [undefined, "interrupted"],
  );
  // Later, C ran fine: B still shows its stop (its own end line), A and C not.
  const now = currentTurnIndex(turns, () => false);
  assert.deepEqual(
    turns.map((t, i) => turnEnd(t, i === now ? "idle" : undefined)),
    [undefined, "interrupted", "idle"],
  );
});

test("N-6: Claude Code's diagnostics stay out of the conversation", async () => {
  const { claudeResultError } = await import(
    "../packages/daisy/src/harness/claude.ts"
  );
  const diag =
    "[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null";
  const r = { subtype: "error_during_execution", is_error: true, errors: [diag] };
  assert.equal(claudeResultError(r, true), "本轮已停止");
  assert.equal(
    claudeResultError(r, false),
    "Claude Code 本轮异常结束（error_during_execution）",
  );
  assert.equal(
    claudeResultError({ ...r, errors: [diag, "API Error: overloaded"] }, false),
    "API Error: overloaded",
  );
});

test("N-5: /status gives model, reasoning effort and usage as reported, 「不可用」 otherwise", async () => {
  const { statusRows } = await import("../packages/ui/src/present.ts");
  const at = Date.UTC(2026, 10, 17, 7, 0);
  const value = (rows: any[], label: string) =>
    rows.find((r) => r.label === label);
  const fresh = statusRows(
    { agent: "codex", status: "idle", nativeId: null } as any,
    { account: "Codex 身份" },
    [],
    at,
  );
  assert.equal(value(fresh, "身份")?.value, "Codex 身份");
  assert.equal(value(fresh, "模型")?.value, "不可用");
  assert.match(value(fresh, "模型")?.note, /还没有报告/);
  assert.equal(value(fresh, "推理强度")?.value, "不可用");
  assert.equal(value(fresh, "周额度")?.value, "不可用");
  assert.equal(value(fresh, "缓存命中率")?.value, "不可用");
  const ran = statusRows(
    {
      agent: "codex",
      status: "idle",
      nativeId: "thread-1",
      runtime: { model: "gpt-6-luna", effort: "medium", permissionMode: "on-request", at },
      settings: { model: "gpt-6-luna", reasoningEffort: "high" },
      quota: {
        v: 1,
        profileId: "p",
        provider: "codex-chatgpt",
        status: "ok",
        plan: { name: "ChatGPT Pro Lite", source: "provider" },
        windows: [{ kind: "weekly", usedPercent: 6, resetsAt: at + 86_400_000 }],
        fetchedAt: at,
        via: "stream",
      },
    } as any,
    {},
    [],
    at,
  );
  assert.equal(value(ran, "模型")?.value, "gpt-6-luna");
  assert.equal(value(ran, "模型")?.note, undefined);
  assert.equal(value(ran, "推理强度")?.value, "中（medium）");
  assert.equal(value(ran, "推理强度")?.note, "已选 high，下一轮生效");
  assert.equal(value(ran, "权限模式")?.value, "on-request");
  assert.equal(value(ran, "套餐")?.value, "ChatGPT Pro Lite");
  assert.equal(value(ran, "周额度")?.value, "剩余 94%");
  assert.equal(value(ran, "5 小时额度")?.value, "不可用");
});

test("N-8: /status reads an idle session that has run turns as 已完成, not 未开始", async () => {
  const { statusRows, sessionStateKey } = await import(
    "../packages/ui/src/present.ts"
  );
  const state = (rows: any[]) => rows.find((r) => r.label === "状态")?.value;
  // Codex, many turns done, now idle (the device case).
  const ran = { agent: "codex", status: "idle", nativeId: "thread-1", contextDelivered: true } as any;
  assert.equal(state(statusRows(ran)), "completed");
  // Only the transcript shows turns (no native id reported yet / after a fresh identity).
  assert.equal(
    sessionStateKey({ status: "idle", nativeId: null, contextDelivered: false } as any, [
      { kind: "user" },
      { kind: "assistant" },
    ] as any),
    "completed",
  );
  // A session that never ran is still 未开始.
  assert.equal(state(statusRows({ agent: "codex", status: "idle", nativeId: null } as any)), "idle");
  // Other states pass through.
  for (const s of ["queued", "running", "waiting", "interrupted", "error"])
    assert.equal(state(statusRows({ agent: "codex", status: s, nativeId: "t" } as any)), s);
  // commands.tsx shows the value through copy.labels: completed → 「已完成」.
  const { uiMessages } = await import("./ui-pack.ts");
  assert.equal(uiMessages("zh-CN")["ui-copy.labels.completed"], "已完成");
  assert.equal(uiMessages("en")["ui-copy.labels.completed"], "Done");
});

test("ADR-159: the trace bar line, step phrases, times and background kinds in English", async () => {
  await inUiLang("en", () => {
    const at = 1_000_000;
    const item = (id: string, patch: any) => ({ id: `j:${id}`, kind: "tool" as const, text: "", createdAt: at, ...patch });
    const steps = [
      item("t1", { name: "Read", input: { file_path: "/w/src/chat.tsx" }, status: "complete" }),
      item("t2", { name: "Bash", input: { command: "npm test" }, status: "running", createdAt: at - 42_000 }),
    ];
    assert.equal(stepLine(steps, at), "Step 2 · Run npm test · 42s");
    steps[1].status = "complete";
    assert.match(stepLine(steps, at), /^Step 2 done: Run npm test/);
    assert.match(stepLine(steps, at, { streaming: true }), /2 steps done/);
    assert.equal(stepPhrase(steps[0]), "Read chat.tsx");
    assert.equal(elapsedText(185_000), "3m 05s");
    assert.equal(agoText(30_000), "just now");
    assert.match(agoText(3 * 60_000), /3 min ago/);
    assert.match(backgroundKind({ kind: "wakeup" } as any).kind, /Timer/);
    assert.match(backgroundKind({ kind: "task", type: "local_bash" } as any).kind, /Background command/);
    // Times follow the UI's language when there is no branding lang.
    assert.match(daisyTimeFormat({}).time(new Date(2026, 9, 10, 15, 42).getTime()), /PM/);
  });
  // Back in Chinese: a 24-hour clock without branding lang.
  assert.doesNotMatch(daisyTimeFormat({}).time(new Date(2026, 9, 10, 15, 42).getTime()), /PM|下午/);
});
