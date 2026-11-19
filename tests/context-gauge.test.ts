// the composer ring, its bubble and the 自动压缩阈值 setting text
// (pure functions in packages/ui present.ts, shared by Web and the App).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  autoCompactView,
  cacheRate,
  contextBubble,
  contextGauge,
  kTokens,
} from "../packages/ui/src/present.ts";
import { inUiLang, uiLang } from "./ui-pack.ts";

// ADR-159 §8: the UI speaks Chinese in these assertions.
uiLang("zh-CN");

const NOW = Date.parse("2026-11-01T12:00:00Z");
const context = (over: any = {}, threshold: any = {}) => ({
  v: 1 as const,
  agent: "claude" as const,
  used: 50_000,
  window: 1_000_000,
  threshold: {
    tokens: 167_000,
    source: "harness",
    origin: "identity",
    enabled: true,
    exact: true,
    window: 200_000,
    requested: 200_000,
    applied: true,
    ...threshold,
  },
  cache: { prompt: 50_000, read: 40_000, write: 9_990 },
  cacheSession: { prompt: 100_000, read: 90_000, write: 10_000 },
  itemId: "j:context",
  updatedAt: NOW,
  ...over,
});
const session = (c: any, extra: any = {}) =>
  ({ agent: "claude", context: c, ...extra }) as any;

test("contextGauge: used / the reported trigger point, colour bands, ≥100 %, ≈", () => {
  const g = contextGauge(session(context()));
  assert.equal(g.available, true);
  assert.equal(g.percent, 30); // 50K / 167K, not / 200K, not / 1M
  assert.equal(g.text, "30%");
  assert.equal(g.tone, "normal");
  assert.equal(
    contextGauge(session(context({ used: 117_000 }))).tone,
    "warning",
  ); // 70 %
  assert.equal(
    contextGauge(session(context({ used: 151_000 }))).tone,
    "danger",
  ); // 90 %
  const over = contextGauge(session(context({ used: 170_000 })));
  assert.equal(over.text, "≥100%");
  assert.equal(over.over, true);
  assert.equal(over.fill, 1);
  assert.match(over.reason!, /已超过压缩阈值/);
  assert.equal(
    contextGauge(session(context({}, { exact: false }))).text,
    "≈30%",
  );
  // Compaction: the ring drops with the conversation.
  const after = contextGauge(session(context({ used: 9_900 })));
  assert.equal(after.percent, 6);
});

test("contextGauge: no trigger point → 「不可用」 with the reason, never the model window", () => {
  const none = contextGauge(
    session(
      context(
        {},
        {
          tokens: null,
          source: "unknown",
          reason: "Codex 没有配置自动压缩上限",
        },
      ),
    ),
  );
  assert.equal(none.available, false);
  assert.equal(none.percent, null);
  assert.equal(none.text, "—");
  assert.equal(none.tone, "muted");
  assert.match(none.reason!, /Codex/);
  // Off.
  const off = contextGauge(
    session(context({}, { tokens: null, enabled: false, reason: undefined })),
  );
  assert.equal(off.reason, "自动压缩已关闭");
  // A tokens value without a trusted source is not used either.
  assert.equal(
    contextGauge(session(context({}, { source: "unknown" }))).available,
    false,
  );
  // Older Runner: only the first context items ({used, window}) — not divided.
  const legacy = contextGauge(session(undefined), [
    {
      id: "j:context",
      kind: "tool",
      category: "usage",
      text: "",
      input: { used: 50000, window: 200000 },
      createdAt: NOW,
    },
  ]);
  assert.equal(legacy.available, false);
  assert.match(legacy.reason!, /Runner 版本过旧/);
  assert.match(contextGauge(session(undefined)).reason!, /尚无数据/);
});

test("contextBubble: five rows, 不可用 with reasons, owner-only quota, reset and cache wording", () => {
  const quota = {
    v: 1,
    profileId: "p",
    provider: "claude-subscription",
    status: "ok",
    plan: { name: "max", source: "provider" },
    identity: "我的 Claude",
    windows: [
      { kind: "five_hour", usedPercent: 30, resetsAt: NOW + 3_600_000 },
      { kind: "weekly", usedPercent: 55, resetsAt: NOW - 1000 },
    ],
    fetchedAt: NOW - 120_000,
    via: "cli-control",
  };
  const rows = contextBubble(
    session(
      context({
        lastCompact: {
          at: NOW - 180_000,
          trigger: "auto",
          preTokens: 340_515,
          postTokens: 9_879,
        },
      }),
      { quota },
    ),
    [],
    NOW,
    () => "13:00",
  );
  const by = Object.fromEntries(rows.map((r) => [r.key, r]));
  assert.deepEqual(
    rows.map((r) => r.key),
    ["plan", "weekly", "five_hour", "cache", "context"],
  );
  assert.equal(by.plan.value, "max · 我的 Claude");
  assert.equal(by.five_hour.value, "剩余 70%");
  assert.match(by.five_hour.note!, /13:00 重置/);
  assert.match(by.five_hour.note!, /更新于 2 分钟前/);
  assert.equal(by.weekly.value, "剩余 45%");
  assert.match(by.weekly.note!, /已重置，待刷新/);
  assert.equal(by.cache.value, "90%");
  assert.match(by.cache.note!, /本轮 80%/);
  assert.match(by.cache.note!, /缓存读取 90K \/ 全部输入 100K/);
  assert.equal(by.context.value, "50K / 167K（30%）");
  assert.match(
    by.context.note!,
    /Claude 报告的压缩触发点 · 压缩窗口 200K · 来源：身份设置/,
  );
  assert.match(by.context.note!, /模型窗口 1M（仅说明）/);
  assert.match(by.context.note!, /上次压缩：341K → 9.9K（自动 · 3 分钟前）/);
  // Not the owner: quota rows say so; the context still shows.
  const hidden = contextBubble(
    session(context(), { quota, quotaHidden: true }),
    [],
    NOW,
  );
  assert.equal(hidden[0].note, "仅会话所有者可见");
  assert.equal(hidden[1].value, "不可用");
  // GLM: the identity's name as plan, quota windows 不可用 with the reason.
  const glm = contextBubble(
    session(context(), {
      quota: {
        ...quota,
        provider: "glm-coding",
        status: "unavailable",
        reason: "GLM 额度查询尚未接入 Daisy",
        plan: { name: "GLM max", source: "identity-label" },
        identity: "GLM max",
        windows: [],
      },
    }),
    [],
    NOW,
  );
  assert.equal(glm[0].value, "GLM max");
  assert.equal(glm[0].note, "暂用身份名称");
  assert.equal(glm[1].value, "不可用");
  assert.match(glm[1].note!, /GLM/);
  // Nothing yet.
  const empty = contextBubble(session(undefined), [], NOW);
  assert.ok(empty.every((r) => r.unavailable));
  assert.equal(cacheRate({ prompt: 0, read: 0, write: null }), null);
  assert.equal(kTokens(1_000_000), "1M");
  assert.equal(kTokens(166_999), "167K");
});

test("autoCompactView: the reported trigger point, each conversation's state, 立即重启 names what it interrupts", () => {
  const base = {
    agent: "claude" as const,
    tokens: 200_000,
    support: {
      configurable: true as const,
      range: [100_000, 1_000_000] as [number, number],
    },
    reported: {
      tokens: 167_000,
      source: "harness" as const,
      origin: "identity" as const,
      enabled: true,
      exact: true,
      window: 200_000,
      requested: 200_000,
      applied: true,
      at: NOW - 60_000,
    },
    sessions: [
      {
        title: "构建",
        state: "applied" as const,
        restartNow: false,
        interrupts: [],
      },
    ],
  };
  const v = autoCompactView(base, NOW);
  assert.equal(
    v.trigger,
    "实际触发点：压缩窗口 200K · 约 167K 时压缩（Claude 报告，1 分钟前）",
  );
  assert.match(v.explain, /--autocompact，100K–1M/);
  assert.equal(v.restartable, false);
  const waiting = autoCompactView(
    {
      ...base,
      tokens: 400_000,
      sessions: [
        {
          title: "构建",
          state: "waiting",
          restartNow: false,
          interrupts: ["正在进行的一轮", "1 个后台任务 「npm test」"],
        },
        { title: "闲聊", state: "waiting", restartNow: false, interrupts: [] },
      ],
    },
    NOW,
  );
  assert.match(waiting.trigger, /^当前进程：压缩窗口 200K/);
  assert.match(waiting.trigger, /新值的实际触发点在 AI 重启后由 Claude 报告/);
  assert.equal(waiting.restartable, true);
  assert.match(
    waiting.confirmText,
    /「构建」正在进行的一轮、1 个后台任务 「npm test」/,
  );
  assert.ok(!waiting.confirmText.includes("闲聊"));
  assert.match(waiting.lines[1].text, /空闲，马上自动重启/);
  assert.equal(waiting.settling, true);
  const kimi = autoCompactView({
    ...base,
    agent: "kimi",
    tokens: null,
    support: { configurable: false, reason: "Kimi Code 不报告压缩阈值" },
    reported: null,
    sessions: [],
  });
  assert.equal(kimi.configurable, false);
  assert.match(kimi.disabledReason!, /Kimi/);
  assert.match(kimi.lines[0].text, /没有在线的 AI/);
});

test("Codex without a configured limit: the ring uses Codex's default point (≈), the bubble and setting say how it is derived", () => {
  // As the Codex adapter reports it (Codex 0.157.1, 272K model window).
  const c = context(
    { agent: "codex", used: 61_200, window: 258_400 },
    {
      tokens: 244_800,
      source: "config",
      origin: "cli-default",
      exact: false,
      window: null,
      requested: null,
      applied: null,
      native: "codex-default-90pct",
      reason:
        "Codex 默认在模型上下文窗口 272K 的 90% 处自动压缩（按 Codex 0.157.1 实测的规则推算，Codex 不直接报告这个数）",
    },
  );
  const g = contextGauge(session(c, { agent: "codex" }));
  assert.equal(g.available, true);
  assert.equal(g.text, "≈25%");
  const row = contextBubble(session(c, { agent: "codex" }), [], NOW).find(
    (r) => r.key === "context",
  )!;
  assert.equal(row.value, "61.2K / 245K（≈25%）");
  assert.match(
    row.note!,
    /Codex 默认压缩点（按模型窗口推算） · 来源：CLI 默认/,
  );
  assert.match(row.note!, /272K 的 90%/);
  assert.ok(!/压缩窗口/.test(row.note!));
  // A limit above the cap: the setting is shown as 上限, the ring uses the cap.
  const capped = context(
    { agent: "codex", used: 61_200, window: 258_400 },
    {
      tokens: 244_800,
      source: "config",
      origin: "identity",
      exact: false,
      window: 400_000,
      requested: 400_000,
      applied: true,
    },
  );
  const cappedRow = contextBubble(
    session(capped, { agent: "codex" }),
    [],
    NOW,
  ).find((r) => r.key === "context")!;
  assert.match(cappedRow.note!, /Codex 读回的自动压缩上限 · 设置的上限 400K/);
  const view = (tokens: number | null, reported: any) =>
    autoCompactView(
      {
        agent: "codex",
        tokens,
        support: { configurable: true, range: [10_000, 2_000_000] },
        reported: { ...reported, at: NOW - 60_000 },
        sessions: [],
      },
      NOW,
    );
  const def = view(null, c.threshold);
  assert.equal(
    def.trigger,
    "实际触发点：≈ 245K 时压缩（按 Codex 默认规则推算，1 分钟前）",
  );
  assert.match(def.explain, /不填时 Codex 在模型上下文窗口的 90% 处压缩/);
  // The setting is current when Codex read it back, even if capped.
  assert.equal(
    view(400_000, capped.threshold).trigger,
    "实际触发点：上限 400K · ≈ 245K 时压缩（Codex 报告，1 分钟前）",
  );
});

test("ADR-159: the ring, its bubble and the auto-compact setting in English", async () => {
  await inUiLang("en", () => {
    assert.match(contextGauge(session(undefined as any)).reason!, /No data yet/);
    const rows = contextBubble(session(context()), [], NOW);
    assert.deepEqual(
      rows.map((r) => r.label),
      ["Plan", "Weekly allowance", "5-hour allowance", "Cache hit rate", "Context"],
    );
    assert.equal(rows[0]!.value, "Unavailable");
    assert.match(rows.at(-1)!.note!, /source: profile setting/);
    const v = autoCompactView(
      {
        agent: "claude",
        tokens: null,
        support: { configurable: true, range: [100_000, 1_000_000] },
        reported: null,
        sessions: [],
      },
      NOW,
    );
    assert.match(v.explain, /--autocompact, 100K–1M/);
    assert.match(v.trigger, /^Actual trigger point: not reported yet/);
    assert.match(v.lines[0]!.text, /No AI online/);
  });
});
