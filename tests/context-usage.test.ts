// context usage ring, plan quota and the auto-compact threshold —
// per-CLI parsing, validation, the server's session copy, and the Runner
// applying a threshold at launch / when idle / on 立即重启 (fake CLI).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createApp } from "../packages/daisy/src/app.ts";
import { Store } from "../packages/daisy/src/store/index.ts";
import { OWNER_ID } from "../packages/daisy/src/access/owner.ts";
import { runNode, type NodeConfig } from "../packages/daisy/src/turns/worker.ts";
import {
  claudeThreshold,
  runClaude,
} from "../packages/daisy/src/harness/claude.ts";
import {
  codexDefaultLimit,
  codexThreshold,
  runCodex,
} from "../packages/daisy/src/harness/codex.ts";
import { runKimi } from "../packages/daisy/src/harness/kimi.ts";
import { restartNowReason } from "../packages/daisy/src/turns/live.ts";
import {
  fromClaudeUsage,
  fromCodexRateLimits,
  fromRateLimit,
  resetQuota,
  staticQuota,
} from "../packages/daisy/src/turns/quota.ts";
import type { Runtime } from "../packages/daisy/src/harness/shared.ts";
import { DaisyClient } from "../packages/client/src/index.ts";
import {
  setThresholdAgents,
  requestedAutoCompact,
} from "../packages/daisy/src/harness/shared.ts";
import {
  autoCompactError,
  autoCompactSupport,
  contextUsageCapability,
  versionAtLeast,
  CLAUDE_AUTOCOMPACT_MIN_VERSION,
  parseContextUsage,
  kimiThresholdReason,
  type Snapshot,
} from "../packages/contracts/src/index.ts";
import { runnerConfig } from "./fixtures/runner-calls.ts";
import { packT } from "./ui-pack.ts";

const FIXTURE = resolve("tests/fixtures/agent.cjs");
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(
  read: () => Promise<T>,
  accept: (x: T) => boolean,
  what = "state",
) {
  let last: T | undefined;
  for (let i = 0; i < 200; i++) {
    last = await read();
    if (accept(last)) return last;
    await delay(100);
  }
  throw Error(`${what} timed out: ${JSON.stringify(last)?.slice(0, 1500)}`);
}

test("claudeThreshold: Claude Code's own trigger point, its source, disabled and overridden cases", () => {
  // Measured on 2.1.316 (scripts/probe-autocompact.mjs).
  const flag = {
    maxTokens: 200000,
    autoCompactThreshold: 167000,
    isAutoCompactEnabled: true,
    autocompactSource: "settings",
  };
  assert.deepEqual(claudeThreshold(flag, 200000, 200000, false), {
    tokens: 167000,
    source: "harness",
    origin: "identity",
    enabled: true,
    exact: true,
    window: 200000,
    requested: 200000,
    applied: true,
    native: "settings",
  });
  const byDefault = claudeThreshold(
    {
      ...flag,
      maxTokens: 1000000,
      autoCompactThreshold: 967000,
      autocompactSource: "model-default",
    },
    null,
    null,
    false,
  );
  assert.equal(byDefault.origin, "cli-default");
  assert.equal(byDefault.applied, null);
  assert.equal(byDefault.tokens, 967000);
  // CLAUDE_CODE_AUTO_COMPACT_WINDOW (process or settings.json env) wins.
  const env = claudeThreshold(
    {
      ...flag,
      maxTokens: 300000,
      autoCompactThreshold: 267000,
      autocompactSource: "env",
    },
    200000,
    200000,
    false,
  );
  assert.equal(env.origin, "cli-env");
  assert.equal(env.applied, false);
  assert.match(env.reason!, /CLAUDE_CODE_AUTO_COMPACT_WINDOW 优先/);
  // A new value not yet applied (the process waits to be idle).
  const waiting = claudeThreshold(flag, 400000, 200000, false);
  assert.equal(waiting.applied, false);
  assert.match(waiting.reason!, /空闲后重启生效/);
  // Off: no number, never a fallback.
  const off = claudeThreshold(
    {
      maxTokens: 1000000,
      isAutoCompactEnabled: false,
      autocompactSource: "auto",
    },
    null,
    null,
    false,
  );
  assert.equal(off.tokens, null);
  assert.equal(off.enabled, false);
  assert.match(off.reason!, /自动压缩已关闭/);
  // PCT_OVERRIDE moves the real point without the CLI reporting it.
  const pct = claudeThreshold(flag, 200000, 200000, true);
  assert.equal(pct.exact, false);
  assert.match(pct.reason!, /PCT_OVERRIDE/);
  // An older CLI (no answer / another shape): unknown with a reason.
  const old = claudeThreshold({ commands: [] }, null, null, false);
  assert.equal(old.tokens, null);
  assert.equal(old.source, "unknown");
  assert.ok(old.reason);
});

/**
 * Real Codex 0.157.1 app-server notifications (n-codexring, 2026-11-02, one
 * trivial turn, ChatGPT login; ids replaced). The adapter reads
 * `tokenUsage.last` and `modelContextWindow`.
 */
const CODEX_USAGE_0157 = {
  method: "thread/tokenUsage/updated",
  params: {
    threadId: "thread-1",
    turnId: "turn-1",
    tokenUsage: {
      total: {
        totalTokens: 15231,
        inputTokens: 15226,
        cachedInputTokens: 12288,
        cacheWriteInputTokens: 0,
        outputTokens: 5,
        reasoningOutputTokens: 0,
      },
      last: {
        totalTokens: 15231,
        inputTokens: 15226,
        cachedInputTokens: 12288,
        cacheWriteInputTokens: 0,
        outputTokens: 5,
        reasoningOutputTokens: 0,
      },
      modelContextWindow: 258400,
    },
  },
};
const CODEX_RATE_LIMITS_READ_0157 = {
  ordinaryUsageAllowed: true,
  rateLimits: {
    limitId: "codex",
    limitName: null,
    normalModelSlug: null,
    primary: {
      usedPercent: 58,
      windowDurationMins: 10080,
      resetsAt: 1793776566,
    },
    secondary: null,
    credits: { hasCredits: false, unlimited: false, balance: "0" },
    individualLimit: null,
    spendControlReached: false,
    planType: "prolite",
    rateLimitReachedType: null,
  },
  rateLimitResetCredits: { availableCount: 3, credits: null },
  accountId: "00000000-0000-0000-0000-000000000000",
  rateLimitUpsell: null,
};

test("codexThreshold: no limit → Codex's own default, 90% of the model window (≈); a limit above it is capped", () => {
  const window = CODEX_USAGE_0157.params.tokenUsage.modelContextWindow;
  // Default: the 272K model (reported as 95%: 258400) compacts at 244800.
  const def = codexThreshold(
    { model_auto_compact_token_limit: null },
    null,
    null,
    window,
  );
  assert.equal(def.tokens, 244800);
  assert.equal(def.source, "config");
  assert.equal(def.origin, "cli-default");
  assert.equal(def.exact, false);
  assert.equal(def.enabled, true);
  assert.equal(def.window, null);
  assert.equal(def.applied, null);
  assert.match(def.reason!, /272K 的 90%/);
  // A configured limit below the cap is what Codex compares with.
  const set = codexThreshold(
    { model_auto_compact_token_limit: 180000 },
    180000,
    180000,
    window,
  );
  assert.equal(set.tokens, 180000);
  assert.equal(set.source, "config");
  assert.equal(set.origin, "identity");
  assert.equal(set.exact, false);
  assert.equal(set.applied, true);
  assert.equal(set.window, 180000);
  assert.equal(set.reason, undefined);
  // Before the first usage update the limit alone is shown, as before.
  assert.equal(
    codexThreshold({ model_auto_compact_token_limit: 180000 }, null, null)
      .tokens,
    180000,
  );
  // Above 90% of the window: Codex compacts at 90% (measured).
  const big = codexThreshold(
    { model_auto_compact_token_limit: 400000 },
    400000,
    400000,
    window,
  );
  assert.equal(big.tokens, 244800);
  assert.equal(big.window, 400000);
  assert.equal(big.applied, true);
  assert.match(big.reason!, /超过模型上下文窗口 272K 的 90%/);
  // A new identity value not yet applied (default still running).
  const waiting = codexThreshold(
    { model_auto_compact_token_limit: null },
    150000,
    null,
    window,
  );
  assert.equal(waiting.tokens, 244800);
  assert.equal(waiting.applied, false);
  assert.match(waiting.reason!, /空闲后重启生效/);
  // No window yet / no config answer: unknown, never a made-up number.
  const none = codexThreshold(
    { model_auto_compact_token_limit: null },
    null,
    null,
  );
  assert.equal(none.tokens, null);
  assert.match(none.reason!, /还没有报告模型窗口/);
  assert.equal(codexThreshold(null, null, null).tokens, null);
  // config/read failed and no launch flag: Codex's config.toml may set any
  // limit, so the 90% default is not assumed (review N, item 1).
  assert.equal(codexThreshold(null, null, null, window).tokens, null);
  // The reason fits the contract (≤ 300 chars).
  for (const t of [def, big, waiting, none])
    assert.ok(!t.reason || t.reason.length <= 300);
});

test("codexThreshold: config/read failed → the launch flag's limit, said to be assumed, never the 90% default (review N, item 1)", () => {
  const window = CODEX_USAGE_0157.params.tokenUsage.modelContextWindow;
  const t = codexThreshold(null, 100000, 100000, window);
  assert.equal(t.tokens, 100000);
  assert.equal(t.origin, "identity");
  assert.equal(t.source, "config");
  assert.equal(t.exact, false);
  assert.equal(t.window, 100000);
  assert.equal(t.applied, true);
  assert.match(t.reason!, /没有回答配置查询，上限按启动参数/);
  assert.ok(!/默认/.test(t.reason!));
  assert.notEqual(t.native, "codex-default-90pct");
  // Before the first usage update too; and still capped at 90%.
  assert.equal(codexThreshold(null, 100000, 100000).tokens, 100000);
  const big = codexThreshold(null, 400000, 400000, window);
  assert.equal(big.tokens, 244800);
  assert.match(big.reason!, /推定.*；设置的上限 400K 超过/);
  // A new value waiting for the restart: still the launched one.
  const waiting = codexThreshold(null, 150000, 100000, window);
  assert.equal(waiting.tokens, 100000);
  assert.equal(waiting.applied, false);
  assert.match(waiting.reason!, /空闲后重启生效/);
});

test("codexDefaultLimit: a tiny or junk window is no window, never a 0-token point (review N, item 4)", () => {
  for (const w of [1, 10, 999, -5, NaN, Infinity])
    assert.equal(codexDefaultLimit(w), null, String(w));
  const smallest = codexDefaultLimit(1000)!;
  assert.ok(smallest.tokens > 0);
  const t = codexThreshold(
    { model_auto_compact_token_limit: null },
    null,
    null,
    1,
  );
  assert.equal(t.tokens, null);
  assert.equal(t.source, "unknown");
  // A configured limit still shows, uncapped by a junk window.
  assert.equal(
    codexThreshold({ model_auto_compact_token_limit: 180000 }, null, null, 1)
      .tokens,
    180000,
  );
});

test("Codex: a usage update without modelContextWindow keeps the last window and the ring (review N, item 3)", async () => {
  resetQuota();
  const r = await adapterTurn("codex", {}, { DAISY_FIXTURE_NULL_WINDOW: "1" });
  assert.equal(r.context.used, 32000);
  assert.equal(r.context.window, 258400);
  assert.equal(r.context.threshold.tokens, 244800);
  assert.equal(r.context.threshold.origin, "cli-default");
  resetQuota();
});

test("codexDefaultLimit: matches the compactions measured on Codex 0.157.1", () => {
  // [-c model_context_window, reported modelContextWindow, tokens in the
  //  conversation after turn 1, compacted before turn 2?]
  const measured: [number, number, number, boolean][] = [
    [14400, 13680, 13291, true],
    [14500, 13775, 13292, true],
    [14900, 14155, 13301, false],
    [15000, 14250, 12873, false],
    [16500, 15675, 13337, false],
    [17500, 16625, 13341, false],
  ];
  for (const [w, reported, used, compacted] of measured) {
    const d = codexDefaultLimit(reported)!;
    assert.equal(d.window, w);
    assert.equal(used >= d.tokens, compacted, `window ${w}`);
  }
  assert.equal(codexDefaultLimit(null), null);
  assert.equal(codexDefaultLimit(0), null);
});

test("quota: Codex account/rateLimits → plan and weekly window only; sparse updates merge", () => {
  resetQuota();
  const read = fromCodexRateLimits(
    "p-codex",
    CODEX_RATE_LIMITS_READ_0157,
    1000,
  )!;
  assert.equal(read.status, "ok");
  assert.equal(read.provider, "codex-chatgpt");
  assert.equal(read.via, "cli-rpc");
  assert.deepEqual(read.plan, { name: "ChatGPT Pro Lite", source: "provider" });
  assert.deepEqual(read.windows, [
    { kind: "weekly", usedPercent: 58, resetsAt: 1793776566000 },
  ]);
  const text = JSON.stringify(read);
  for (const leak of ["accountId", "00000000-0000", "credits", "balance"])
    assert.ok(!text.includes(leak), leak);
  // A sparse update: no plan type, a new 5-hour window, weekly moved.
  const upd = fromCodexRateLimits(
    "p-codex",
    {
      rateLimits: {
        limitId: "codex",
        primary: {
          usedPercent: 12,
          windowDurationMins: 300,
          resetsAt: 1793600000,
        },
        secondary: {
          usedPercent: 60,
          windowDurationMins: 10080,
          resetsAt: 1793776566,
        },
        planType: null,
      },
    },
    2000,
  )!;
  assert.equal(upd.plan.name, "ChatGPT Pro Lite");
  assert.deepEqual(
    upd.windows.map((w) => [w.kind, w.usedPercent]),
    [
      ["weekly", 60],
      ["five_hour", 12],
    ],
  );
  // Another bucket (a model-specific limit) is not this plan's quota.
  assert.equal(
    fromCodexRateLimits("p-codex", {
      rateLimits: {
        limitId: "codex_other",
        primary: { usedPercent: 99, windowDurationMins: 300 },
      },
    }),
    null,
  );
  // Junk.
  assert.equal(fromCodexRateLimits("p-x", {}), null);
  assert.equal(fromCodexRateLimits("p-x", null), null);
  resetQuota();
});

test("quota: get_usage → percentages and resets only; rate_limit_event fills in; others say why", () => {
  resetQuota();
  const snap = fromClaudeUsage("p1", {
    subscription_type: "max",
    rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: 30, resets_at: "2026-11-01T15:00:00Z" },
      seven_day: { utilization: 55, resets_at: "2026-11-05T00:00:00Z" },
      seven_day_opus: null,
    },
    account_email: "never@example.com",
    organization_uuid: "org-secret",
  })!;
  assert.equal(snap.status, "ok");
  assert.equal(snap.plan.name, "max");
  assert.deepEqual(
    snap.windows.map((w) => [w.kind, w.usedPercent]),
    [
      ["five_hour", 30],
      ["weekly", 55],
    ],
  );
  assert.equal(snap.windows[0].resetsAt, Date.parse("2026-11-01T15:00:00Z"));
  assert.ok(!JSON.stringify(snap).includes("never@example.com"));
  assert.ok(!JSON.stringify(snap).includes("org-secret"));
  // rate_limit_event (utilization 0–1, resetsAt in seconds) updates one window.
  const merged = fromRateLimit(
    "p1",
    {
      rateLimitType: "five_hour",
      utilization: 0.42,
      resetsAt: 1793545200,
    },
    "max",
  )!;
  assert.equal(
    merged.windows.find((w) => w.kind === "five_hour")!.usedPercent,
    42,
  );
  assert.equal(
    merged.windows.find((w) => w.kind === "five_hour")!.resetsAt,
    1793545200000,
  );
  assert.equal(
    merged.windows.find((w) => w.kind === "weekly")!.usedPercent,
    55,
  );
  // Review S2: get_usage is already 0–100 — 1 % stays 1 %, not 100 %.
  const low = fromClaudeUsage("p3", {
    subscription_type: "pro",
    rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: 1, resets_at: null },
      seven_day: { utilization: 0.5, resets_at: null },
    },
  })!;
  assert.deepEqual(
    low.windows.map((w) => w.usedPercent),
    [1, 0.5],
  );
  // rate_limit_event is a fraction: 1 = 100 %.
  assert.equal(
    fromRateLimit("p4", { rateLimitType: "five_hour", utilization: 1 }, null)!
      .windows[0].usedPercent,
    100,
  );
  // Fallback alone (get_usage never answered).
  const only = fromRateLimit(
    "p2",
    { rateLimitType: "seven_day", utilization: 0.1 },
    "pro",
  )!;
  assert.equal(only.via, "stream");
  assert.equal(only.plan.name, "pro");
  // API key / GLM / Codex / Kimi: a reason, never a number.
  const job = (
    agent: string,
    authMode: string,
    baseUrl = "",
    label = "GLM max",
  ) =>
    ({
      session: { agent },
      profile: { id: "x", authMode, baseUrl, label },
    }) as any;
  assert.equal(staticQuota(job("claude", "apiKey"))!.status, "not-applicable");
  const glm = staticQuota(
    job("claude", "apiKey", "https://open.bigmodel.cn/api/anthropic"),
  )!;
  assert.equal(glm.provider, "glm-coding");
  assert.equal(glm.plan.name, "GLM max");
  assert.equal(glm.plan.source, "identity-label");
  assert.equal(staticQuota(job("kimi", "subscription"))!.status, "unavailable");
  assert.equal(staticQuota(job("claude", "subscription")), null);
  resetQuota();
});

test("autoCompactSupport / autoCompactError: ranges per Agent, Kimi and older Runners refused", () => {
  const caps = { contextUsage: contextUsageCapability() };
  const claude = autoCompactSupport(caps, "claude");
  assert.equal(autoCompactError(200000, claude), null);
  assert.equal(autoCompactError(null, claude), null);
  assert.match(autoCompactError(99999, claude)!, /100K–1000K/);
  assert.match(autoCompactError(1000001, claude)!, /100K–1000K/);
  assert.match(autoCompactError(150000.5, claude)!, /整数/);
  assert.equal(
    autoCompactError(180000, autoCompactSupport(caps, "codex")),
    null,
  );
  assert.equal(
    autoCompactError(200000, autoCompactSupport(caps, "kimi")),
    kimiThresholdReason(),
  );
  assert.match(
    autoCompactError(200000, autoCompactSupport({}, "claude"))!,
    /Runner 版本过旧/,
  );
  // Back to the CLI default is always allowed.
  assert.equal(autoCompactError(null, autoCompactSupport({}, "claude")), null);
  // P6-22: in English (the UI passes its translator).
  const en = packT("en");
  assert.equal(autoCompactError(99999, claude, en), "The threshold must be between 100K and 1000K");
  assert.match(autoCompactError(200000, autoCompactSupport({}, "claude", en), en)!, /Runner is too old/);
  assert.match(
    (contextUsageCapability({ claude: { installed: true, version: "2.1.1" } }, en).agents.claude as any).reason,
    /Claude Code \(2\.1\.1\) cannot take a compaction window per profile; it needs 2\.1\.310 or newer/,
  );
});

test("server: the newest v1 context is copied to the session; cache counters count each job once", () => {
  const dir = mkdtempSync(join(tmpdir(), "daisy-ctx-store-"));
  const store = new Store(dir);
  try {
    const now = Date.now();
    store.save({
      id: "s1",
      ownerId: "u",
      title: "t",
      agent: "claude",
      nodeId: "n",
      workspaceId: "w",
      profileId: "p",
      nativeId: null,
      task: null,
      status: "idle",
      archived: false,
      createdAt: now,
      updatedAt: now,
    } as any);
    const usage = (cache: any, updatedAt: number, used = 1000) => ({
      v: 1,
      agent: "claude",
      used,
      window: 200000,
      threshold: {
        tokens: 167000,
        source: "harness",
        origin: "cli-default",
        enabled: true,
        exact: true,
        window: 200000,
        requested: null,
        applied: null,
      },
      cache,
      updatedAt,
    });
    const item = (jid: string, input: any) => ({
      id: `${jid}:context`,
      kind: "tool",
      category: "usage",
      text: "",
      input,
    });
    // An older Runner's item does not make a session context.
    store.append("s1", "item", item("j0", { used: 5, window: 10 }));
    assert.equal(store.session("s1")!.context, undefined);
    store.append(
      "s1",
      "item",
      item("j1", usage({ prompt: 100, read: 60, write: 40 }, now)),
    );
    // The same job's item again (a later update and a replay under a new event id).
    store.append(
      "s1",
      "item",
      item("j1", usage({ prompt: 200, read: 150, write: 50 }, now + 1)),
    );
    store.append(
      "s1",
      "item",
      item("j1", usage({ prompt: 200, read: 150, write: 50 }, now + 1)),
    );
    assert.deepEqual(store.session("s1")!.context!.cacheSession, {
      prompt: 200,
      read: 150,
      write: 50,
    });
    store.append(
      "s1",
      "item",
      item("j2", usage({ prompt: 300, read: 290, write: 10 }, now + 2, 9000)),
    );
    const s = store.session("s1")!;
    assert.deepEqual(s.context!.cacheSession, {
      prompt: 500,
      read: 440,
      write: 60,
    });
    assert.equal(s.context!.used, 9000);
    assert.equal(s.context!.itemId, "j2:context");
    // A late update of an earlier job counts, but does not replace the newest.
    store.append(
      "s1",
      "item",
      item("j1", usage({ prompt: 210, read: 150, write: 50 }, now + 1, 1)),
    );
    assert.equal(store.session("s1")!.context!.used, 9000);
    assert.equal(store.session("s1")!.context!.cacheSession!.prompt, 510);
    // Review S1: a process restarted between turns reports into the last
    // job's item with no counters of its own (cache null, no lastCompact):
    // the job keeps its counters and its last compaction.
    store.append(
      "s1",
      "item",
      item("j2", {
        ...usage({ prompt: 300, read: 290, write: 10 }, now + 3, 9000),
        lastCompact: { at: now, trigger: "auto", preTokens: 9, postTokens: 1 },
      }),
    );
    store.append("s1", "item", item("j2", usage(null, now + 4, 17000)));
    const warm = store.session("s1")!.context!;
    assert.equal(warm.used, 17000);
    assert.deepEqual(warm.cacheSession, { prompt: 510, read: 440, write: 60 });
    assert.deepEqual(warm.cache, { prompt: 300, read: 290, write: 10 });
    assert.equal(warm.lastCompact?.postTokens, 1);
    const stored = JSON.parse(
      store.one(
        "SELECT data FROM items WHERE session_id='s1' AND id='j2:context'",
      ).data,
    ).input;
    assert.deepEqual(stored.cache, { prompt: 300, read: 290, write: 10 });
    // The next job counts on top.
    store.append(
      "s1",
      "item",
      item("j3", usage({ prompt: 90, read: 60, write: 30 }, now + 5, 20000)),
    );
    assert.deepEqual(store.session("s1")!.context!.cacheSession, {
      prompt: 600,
      read: 500,
      write: 90,
    });
    // Junk is not a context.
    assert.equal(parseContextUsage({ v: 1, used: "x" }), null);
    // Quota: the newest snapshot, extra fields dropped.
    store.append("s1", "item", {
      id: "j2:quota",
      kind: "tool",
      category: "usage",
      text: "ok",
      input: {
        v: 1,
        profileId: "p",
        provider: "claude-subscription",
        status: "ok",
        plan: { name: "max", source: "provider" },
        windows: [{ kind: "five_hour", usedPercent: 30, resetsAt: null }],
        fetchedAt: now,
        via: "cli-control",
        email: "never@example.com",
      },
    });
    const q = store.session("s1")!.quota!;
    assert.equal(q.plan.name, "max");
    assert.ok(!JSON.stringify(q).includes("never@example.com"));
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/** One adapter turn against the fake CLI, recording its argv. */
async function adapterTurn(
  agent: "claude" | "codex" | "kimi",
  profile: any,
  env: Record<string, string> = {},
) {
  const dir = mkdtempSync(join(tmpdir(), `daisy-ctx-${agent}-`)),
    spawns = join(dir, "spawns.jsonl");
  const saved: Record<string, string | undefined> = {};
  const set = {
    [`DAISY_${agent.toUpperCase()}_BIN`]: FIXTURE,
    DAISY_FIXTURE_ENV_FILE: spawns,
    ...env,
  };
  for (const [k, v] of Object.entries(set)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  const events: any[] = [];
  try {
    const run = { claude: runClaude, codex: runCodex, kimi: runKimi }[agent];
    const rt: Runtime = {
      job: {
        id: "j1",
        session: { id: "s1", agent, nativeId: null },
        profile: {
          id: "p1",
          authMode: "subscription",
          label: "身份",
          ...profile,
        },
        attachments: [],
      } as any,
      cwd: process.cwd(),
      prompt: "Hello",
      files: [],
      signal: new AbortController().signal,
      emit: (type, data) => events.push({ type, data }),
      flush: async () => {},
      approve: async () => ({
        optionId: agent === "codex" ? "accept" : "allow",
      }),
    };
    await run(rt);
    const items = new Map(
      events.filter((e) => e.type === "item").map((e) => [e.data.id, e.data]),
    );
    const argv = readFileSync(spawns, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l).argv)
      .find((a: string[]) => !a.includes("auth"));
    return { items, argv, context: items.get("j1:context")?.input };
  } finally {
    for (const [k, v] of Object.entries(saved))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("Claude: the identity's window is passed as --autocompact, inherited overrides are dropped, the reported trigger point comes back", async () => {
  resetQuota();
  const set = await adapterTurn(
    "claude",
    { autoCompactTokens: 400000 },
    { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "300000", DAISY_FIXTURE_USAGE: "ok" },
  );
  assert.deepEqual(
    set.argv.slice(
      set.argv.indexOf("--autocompact"),
      set.argv.indexOf("--autocompact") + 2,
    ),
    ["--autocompact", "400000"],
  );
  assert.equal(set.context.threshold.tokens, 367000);
  assert.equal(set.context.threshold.origin, "identity");
  assert.equal(set.context.threshold.applied, true);
  assert.equal(set.context.threshold.window, 400000);
  // Plan quota from get_usage, as a `:quota` item (no account fields).
  const quota = set.items.get("j1:quota")?.input;
  assert.equal(quota?.status, "ok");
  assert.equal(quota.plan.name, "max");
  assert.ok(
    !JSON.stringify([...set.items.values()]).includes("never-forwarded"),
  );
  // No identity value: the CLI's own (here the inherited env) is reported as such.
  resetQuota();
  const env = await adapterTurn(
    "claude",
    {},
    {
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: "300000",
      DAISY_FIXTURE_USAGE: "fail",
      DAISY_FIXTURE_RATE_EVENT: "1",
    },
  );
  assert.ok(!env.argv.includes("--autocompact"));
  assert.equal(env.context.threshold.tokens, 267000);
  assert.equal(env.context.threshold.origin, "cli-env");
  // get_usage failed: rate_limit_event is the fallback.
  const fallback = env.items.get("j1:quota")?.input;
  assert.equal(fallback?.via, "stream");
  assert.equal(fallback.windows[0].usedPercent, 42);
  // Auto-compact off: 「不可用」, no number.
  const off = await adapterTurn("claude", {}, { DISABLE_AUTO_COMPACT: "1" });
  assert.equal(off.context.threshold.tokens, null);
  assert.equal(off.context.threshold.enabled, false);
  resetQuota();
});

test("Codex: the identity's limit is passed with -c and read back; Kimi says why it has none", async () => {
  const codex = await adapterTurn("codex", { autoCompactTokens: 180000 });
  assert.ok(codex.argv.includes("model_auto_compact_token_limit=180000"));
  assert.equal(codex.context.threshold.tokens, 180000);
  assert.equal(codex.context.threshold.source, "config");
  assert.equal(codex.context.threshold.applied, true);
  assert.deepEqual(codex.context.cache, {
    prompt: 30000,
    read: 24000,
    write: null,
  });
  // The plan quota from account/rateLimits (read, then the turn's update).
  const quota = codex.items.get("j1:quota")?.input;
  assert.equal(quota?.status, "ok");
  assert.equal(quota?.plan.name, "ChatGPT Pro Lite");
  assert.equal(quota?.identity, "身份");
  assert.deepEqual(quota?.windows, [
    { kind: "weekly", usedPercent: 61, resetsAt: 1793776565000 },
  ]);
  assert.ok(!JSON.stringify(quota).includes("fixture-account-id"));
  // Review N item 2: the raw notification (credits, plan type) is never an
  // item of its own — only the owner-only `:quota` snapshot carries quota.
  assert.ok(
    ![...codex.items.keys()].some((k) => k.includes("account/rateLimits")),
  );
  for (const item of codex.items.values())
    assert.ok(
      !/hasCredits|"balance"|planType/.test(JSON.stringify(item)),
      item.id,
    );
  resetQuota();
  // No limit set: Codex's own default point, 90% of the model window.
  const plain = await adapterTurn("codex", {});
  assert.ok(
    !plain.argv.some((a: string) => a.startsWith("model_auto_compact")),
  );
  assert.equal(plain.context.used, 31000);
  assert.equal(plain.context.window, 258400);
  assert.equal(plain.context.threshold.tokens, 244800);
  assert.equal(plain.context.threshold.origin, "cli-default");
  assert.equal(plain.context.threshold.exact, false);
  // An API-key style login has no plan quota to read.
  resetQuota();
  const key = await adapterTurn(
    "codex",
    { authMode: "apiKey" },
    { DAISY_FIXTURE_AUTH: "apiKey" },
  );
  assert.equal(key.items.get("j1:quota")?.input.status, "unavailable");
  resetQuota();
  const kimi = await adapterTurn("kimi", {});
  assert.equal(kimi.items.get("j1:quota")?.input.provider, "kimi-code");
});

async function daisy() {
  const dir = mkdtempSync(join(tmpdir(), "daisy-autocompact-"));
  const ctx = await createApp({ pinGate: false,
    workspaceHome: dir,
    workspaceRoots: [dir],
    dataDir: dir,
  });
  const url = await ctx.app.listen({ host: "127.0.0.1", port: 0 });
  const c = new DaisyClient(url, ctx.issueToken());
  const spawns = join(dir, "spawns.jsonl");
  for (const a of ["CLAUDE", "CODEX", "KIMI"])
    process.env[`DAISY_${a}_BIN`] = FIXTURE;
  process.env.DAISY_FIXTURE_ENV_FILE = spawns;
  process.env.DAISY_FIXTURE_USAGE = "ok";
  // The auto-compact threshold gates Claude's --autocompact on `claude --version`.
  process.env.DAISY_FIXTURE_CLI_VERSION = "2.1.316";
  mkdirSync(join(dir, "state"));
  const config: NodeConfig = {
    ...runnerConfig(ctx, join(dir, "runner.json")),
    identityRoot: join(dir, "state"),
    liveIdleMs: 600_000,
    // Spawn records are told apart by DAISY_TEST_SESSION (P4-13: the test-only plugin tests/plugins/session-tag).
    plugins: ["session-tag"],
  };
  const controller = new AbortController();
  const worker = runNode(config, controller.signal);
  const cat = await c.catalog();
  const profile = (agent: string) =>
    cat.profiles.find((p) => p.agent === agent)!;
  const launches = (sid: string) =>
    existsSync(spawns)
      ? readFileSync(spawns, "utf8")
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l))
          .filter((x) => x.DAISY_TEST_SESSION === sid && x.argv.includes("-p"))
          .map((x) => x.argv as string[])
      : [];
  const window = (argv: string[]) =>
    argv.includes("--autocompact")
      ? Number(argv[argv.indexOf("--autocompact") + 1])
      : null;
  const idle = (x: Snapshot) =>
    !["queued", "running", "waiting"].includes(x.session.status);
  /** Send; approve the fixture's tool request unless told not to. */
  const send = async (sid: string, text: string, approve = true) => {
    await c.send(sid, text);
    const w = await until(
      () => c.snapshot(sid),
      (x) =>
        x.approvals.some((a) => a.status === "pending") ||
        (idle(x) && x.items.some((i) => i.kind === "assistant")),
      "turn",
    );
    const a = w.approvals.find((a) => a.status === "pending");
    if (a && approve) await c.approve(sid, a.id, a.options[0].id);
    return a;
  };
  const close = async () => {
    controller.abort();
    await worker.catch(() => {});
    await ctx.app.close();
    for (const k of [
      "DAISY_CLAUDE_BIN",
      "DAISY_CODEX_BIN",
      "DAISY_KIMI_BIN",
      "DAISY_FIXTURE_ENV_FILE",
      "DAISY_FIXTURE_USAGE",
      "DAISY_FIXTURE_WAKE_MS",
      "DAISY_FIXTURE_CLI_VERSION",
    ])
      delete process.env[k];
    rmSync(dir, { recursive: true, force: true });
  };
  return { ctx, c, cat, profile, launches, window, idle, send, close };
}

test(
  "end to end (fake Claude): ring data on the session, identity threshold validated, applied at launch, restarted when idle, 立即重启 interrupts",
  { timeout: 120_000 },
  async () => {
    resetQuota();
    process.env.DAISY_FIXTURE_WAKE_MS = "2500";
    const h = await daisy();
    const { c, profile, launches, window } = h;
    try {
      const claude = profile("claude");
      const health = await fetch(`${(c as any).baseUrl}/api/health`).then((r) =>
        r.json(),
      );
      assert.equal(health.features.contextUsage, 1);
      const { id: sid } = await c.create({
        agent: "claude",
        title: "ring",
        profileId: claude.id,
        workspaceId: h.cat.workspaces[0].id,
      });
      await h.send(sid, "Hello");
      let snap = await until(
        () => c.snapshot(sid),
        (x) =>
          h.idle(x) &&
          x.session.context?.threshold.source === "harness" &&
          !!x.session.quota,
        "session context",
      );
      // The ring's data, whatever window of items a client loads.
      assert.equal(snap.session.context!.threshold.tokens, 167000);
      assert.equal(snap.session.context!.used, 50000);
      assert.deepEqual(snap.session.context!.cacheSession, {
        prompt: 50000,
        read: 40000,
        write: 9990,
      });
      assert.equal(snap.session.quota!.plan.name, "max");
      assert.equal(window(launches(sid)[0]), null);

      // Validation against what the node's Runner can apply.
      await assert.rejects(
        c.setAutoCompact(claude.id, 99_999),
        (e: any) => e.status === 422 && /100K/.test(e.message),
      );
      await assert.rejects(
        c.setAutoCompact(profile("kimi").id, 200_000),
        (e: any) => e.status === 422 && /Kimi/.test(e.message),
      );
      // A threshold-only PATCH leaves model / effort alone.
      const before = (await c.catalog()).profiles.find(
        (p) => p.id === claude.id,
      )!;

      // Idle: the online process restarts with the new window by itself.
      const saved = await c.setAutoCompact(claude.id, 400_000);
      assert.equal(saved.autoCompactTokens, 400_000);
      assert.equal(saved.model, before.model);
      assert.equal(saved.reasoningEffort, before.reasoningEffort);
      await until(
        () => Promise.resolve(launches(sid)),
        (l) => l.length === 2,
        "idle restart",
      );
      assert.equal(window(launches(sid)[1]), 400_000);
      // It resumed the same conversation, and reported the new trigger point.
      assert.ok(launches(sid)[1].includes("--resume"));
      snap = await until(
        () => c.snapshot(sid),
        (x) =>
          x.session.context?.threshold.tokens === 367000 &&
          x.session.live?.autoCompact?.tokens === 400_000,
        "new trigger point",
      );
      assert.equal(snap.session.context!.threshold.applied, true);
      assert.equal(snap.session.live!.online, true);
      assert.ok(
        snap.items.some(
          (i) => i.kind === "notice" && /空闲时已重启/.test(i.text),
        ),
      );
      let status = await until(
        () => c.autoCompact(claude.id),
        (s) => s.sessions[0]?.state === "applied",
        "applied after the idle restart",
      );
      assert.equal(status.tokens, 400_000);
      assert.deepEqual(status.sessions.map((x) => x.sessionId), [sid]);
      // N4: the restart is not activity — idle clocks keep counting from
      // the last turn, not from the restart. Measured against the restart
      // itself (its notice), not against the moment of the PATCH (Q-3):
      // Claude's `session_state_changed` idle comes a little after the
      // turn's result (the fake CLI: 30 ms later), after the turn may
      // already show as ended — it is the last turn's activity, and on a
      // fast machine it landed after the PATCH (Linux, 2 runs in 8).
      const restartNotice = snap.items.find(
        (i) => i.kind === "notice" && /空闲时已重启/.test(i.text),
      )!;
      const carried = (await c.snapshot(sid)).session.live!.lastActivity!;
      assert.ok(
        carried < restartNotice.createdAt,
        `lastActivity ${carried} is before the restart ${restartNotice.createdAt}`,
      );
      assert.equal(status.reported!.tokens, 367000);

      // Background work: the new value waits until it is done.
      await h.send(sid, "BG_TEST");
      await until(
        () => c.snapshot(sid),
        (x) => (x.session.live?.pending?.length ?? 0) > 0,
        "background task",
      );
      await c.setAutoCompact(claude.id, 300_000);
      status = await until(
        () => c.autoCompact(claude.id),
        (s) =>
          s.sessions[0]?.state === "waiting" &&
          s.sessions[0].interrupts.length > 0,
        "waiting for idle",
      );
      assert.match(status.sessions[0].interrupts.join(), /1 个后台任务/);
      assert.equal(
        launches(sid).length,
        2,
        "not restarted while the background task runs",
      );
      // Task done (the Agent's own follow-up turn ends): restarted.
      await until(
        () => Promise.resolve(launches(sid)),
        (l) => l.length === 3,
        "restart after background",
      );
      assert.equal(window(launches(sid)[2]), 300_000);

      // 立即重启: a turn waiting for authorization is interrupted.
      const pending = await h.send(sid, "Hello again", false);
      assert.ok(pending, "the turn waits for authorization");
      await c.setAutoCompact(claude.id, 500_000);
      status = await until(
        () => c.autoCompact(claude.id),
        (s) =>
          s.sessions[0]?.state === "waiting" &&
          s.sessions[0].interrupts.length > 0,
        "waiting (busy)",
      );
      assert.deepEqual(status.sessions[0].interrupts, ["正在进行的一轮"]);
      await delay(1500);
      assert.equal(
        launches(sid).length,
        3,
        "a running turn is never restarted by itself",
      );
      await c.restartForAutoCompact(claude.id);
      await until(
        () => Promise.resolve(launches(sid)),
        (l) => l.length === 4,
        "restart now",
      );
      assert.equal(window(launches(sid)[3]), 500_000);
      snap = await until(
        () => c.snapshot(sid),
        (x) => h.idle(x) && x.session.live?.autoCompact?.tokens === 500_000,
        "after restart now",
      );
      assert.ok(
        snap.items.some(
          (i) => i.kind === "notice" && i.text.includes(restartNowReason()),
        ),
      );
      status = await until(
        () => c.autoCompact(claude.id),
        (s) => s.sessions[0]?.state === "applied",
        "applied",
      );
      assert.equal(status.sessions[0].restartNow, false);
      // Back to the CLI default.
      await c.setAutoCompact(claude.id, null);
      await until(
        () => Promise.resolve(launches(sid)),
        (l) => l.length === 5,
        "restart to default",
      );
      assert.equal(window(launches(sid)[4]), null);
    } finally {
      await h.close();
      resetQuota();
    }
  },
);

test("review N3: Claude takes a threshold only from the CLI version that has --autocompact", () => {
  assert.equal(CLAUDE_AUTOCOMPACT_MIN_VERSION, "2.1.310");
  assert.equal(versionAtLeast("2.1.316 (Claude Code)", "2.1.310"), true);
  assert.equal(versionAtLeast("2.1.310 (Claude Code)", "2.1.310"), true);
  assert.equal(versionAtLeast("2.1.309 (Claude Code)", "2.1.310"), false);
  assert.equal(versionAtLeast("2.0.99", "2.1.310"), false);
  assert.equal(versionAtLeast("3.0.0", "2.1.310"), true);
  assert.equal(versionAtLeast("", "2.1.310"), false);
  const old = contextUsageCapability({
    claude: { installed: true, version: "2.1.309 (Claude Code)" },
    codex: { installed: true, version: "codex-cli 0.157.1" },
  });
  const why = autoCompactSupport({ contextUsage: old }, "claude");
  assert.equal(why.configurable, false);
  assert.match((why as any).reason, /2\.1\.309.*2\.1\.310/);
  assert.equal(
    autoCompactSupport({ contextUsage: old }, "codex").configurable,
    true,
  );
  assert.equal(
    contextUsageCapability({ claude: { installed: false } }).agents.claude!
      .configurable,
    false,
  );
  // The Runner then never passes --autocompact to that CLI.
  const job = (agent: string) =>
    ({ session: { agent }, profile: { autoCompactTokens: 200000 } }) as any;
  setThresholdAgents(old);
  try {
    assert.equal(requestedAutoCompact(job("claude")), null);
    assert.equal(requestedAutoCompact(job("codex")), 200000);
  } finally {
    setThresholdAgents(contextUsageCapability());
  }
  assert.equal(requestedAutoCompact(job("claude")), 200000);
});

test("review S3 / N1: the owner sees the quota everywhere, lists carry none; every settings save is audited (P1-03: no other viewer exists)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "daisy-quota-view-"));
  const ctx = await createApp({ pinGate: false,
    workspaceHome: dir,
    workspaceRoots: [dir],
    dataDir: dir,
  });
  try {
    const store = ctx.store;
    const as = () => ({ authorization: `Bearer ${ctx.issueToken()}` });
    const node = store.one("SELECT id FROM nodes").id,
      ws = store.one("SELECT id FROM workspaces").id,
      profile = store.one("SELECT id FROM profiles WHERE owner_id=?", OWNER_ID).id;
    const now = Date.now();
    store.save({
      id: "s-bob",
      ownerId: OWNER_ID,
      title: "bob's",
      agent: "claude",
      nodeId: node,
      workspaceId: ws,
      profileId: profile,
      nativeId: null,
      task: null,
      status: "idle",
      archived: false,
      createdAt: now,
      updatedAt: now,
    } as any);
    store.run(
      "INSERT INTO jobs(id,session_id,node_id,request_id,text,attachments,status,created) VALUES(?,?,?,?,?,?,?,?)",
      "jq",
      "s-bob",
      node,
      "r-jq",
      "",
      "[]",
      "completed",
      now,
    );
    const quota = {
      id: "jq:quota",
      kind: "tool",
      category: "usage",
      text: "ok",
      input: {
        v: 1,
        profileId: profile,
        provider: "claude-subscription",
        status: "ok",
        plan: { name: "max", source: "provider" },
        windows: [{ kind: "five_hour", usedPercent: 37, resetsAt: null }],
        fetchedAt: now,
        via: "cli-control",
      },
      createdAt: now,
    };
    store.append("s-bob", "item", {
      id: "jq:a",
      kind: "assistant",
      text: "hi",
      createdAt: now,
    });
    store.append("s-bob", "item", quota);
    // An older Runner's raw Codex rate-limit item (review N item 2).
    store.append("s-bob", "item", {
      id: "jq:usage:account/rateLimits/updated:codex-native",
      kind: "tool",
      category: "usage",
      name: "账号额度",
      text: JSON.stringify({
        rateLimits: {
          primary: { usedPercent: 37, windowDurationMins: 10080 },
          credits: { hasCredits: false, balance: "0" },
          planType: "prolite",
        },
      }),
      status: "complete",
      createdAt: now,
    });
    store.append("s-bob", "item", {
      id: "jq:z",
      kind: "assistant",
      text: "end",
      createdAt: now,
    });
    store.run(
      "INSERT INTO job_recoveries VALUES(?,?,?,?)",
      "jq",
      "s-bob",
      JSON.stringify({ status: "idle" }),
      now,
    );
    store.run(
      "INSERT INTO job_recovery_events(job_id,event_id,data) VALUES(?,?,?)",
      "jq",
      "e1",
      JSON.stringify({ id: "e1", type: "item", data: quota }),
    );
    const get = async (url: string, method = "GET", payload?: any) =>
      (
        await ctx.app.inject({
          method: method as any,
          url,
          headers: as(),
          payload,
        })
      ).json();
    const leaks = (x: any) =>
      JSON.stringify(x).includes('"usedPercent":37') ||
      JSON.stringify(x).includes("hasCredits");
    // The owner sees it everywhere.
    assert.ok(leaks(await get("/api/sessions/s-bob")));
    assert.ok(
      JSON.stringify(await get("/api/sessions/s-bob")).includes(
        "hasCredits",
      ),
      "the owner still sees an older Runner's raw rate-limit item",
    );
    assert.ok(leaks(await get("/api/sessions/s-bob/events?after=0")));
    // Lists carry neither (the ring reads the snapshot).
    const list = await get("/api/sessions");
    assert.ok(list.length && !("quota" in list[0]) && !("context" in list[0]));
    // N1: a permission-only save is audited like a model save.
    const audits = () =>
      store.one(
        "SELECT count(*) n FROM audit WHERE action='profile.model' AND target=?",
        profile,
      ).n;
    const before = audits();
    const r = await ctx.app.inject({
      method: "PATCH",
      url: `/api/profiles/${profile}`,
      headers: as(),
      payload: { permissionMode: "acceptEdits" },
    });
    assert.equal(r.statusCode, 200);
    assert.equal(audits(), before + 1);
  } finally {
    await ctx.app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
