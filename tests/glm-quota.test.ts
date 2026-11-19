// GLM Coding Plan quota — the provider's quota endpoint read with
// the identity's own key (fake fetch: no network), parsed to the shared
// QuotaSnapshot, failures said as such (never a made-up number).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fetchGlmQuota,
  fromGlmQuota,
  glmQuotaUrl,
  quotaOf,
  resetQuota,
} from "../packages/daisy/src/turns/quota.ts";
import { parseQuotaSnapshot } from "../packages/contracts/src/context-usage.ts";

const job = (over: Record<string, unknown> = {}) =>
  ({
    session: { agent: "claude" },
    profile: {
      id: "p-glm",
      label: "GLM max",
      authMode: "apiKey",
      baseUrl: "https://open.bigmodel.cn/api/anthropic",
      apiKey: "secret-key",
      ...over,
    },
  }) as any;
const reply = (status: number, text: string) => async () => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => text,
});
const RESET_5H = 1793700000000,
  RESET_WEEK = 1794200000000;
const body = (limits: unknown[]) =>
  JSON.stringify({
    code: 200,
    msg: "操作成功",
    success: true,
    data: { limits },
  });

test("glmQuotaUrl: same origin as the base URL, the quota path", () => {
  assert.equal(
    glmQuotaUrl("https://open.bigmodel.cn/api/anthropic"),
    "https://open.bigmodel.cn/api/monitor/usage/quota/limit",
  );
  assert.equal(
    glmQuotaUrl("https://api.z.ai/api/anthropic/"),
    "https://api.z.ai/api/monitor/usage/quota/limit",
  );
  assert.equal(glmQuotaUrl(""), null);
  assert.equal(glmQuotaUrl("ftp://x"), null);
});

test("fetchGlmQuota: two windows, the key sent as is, TIME_LIMIT skipped", async () => {
  resetQuota();
  let seen: any = null;
  const snap = await fetchGlmQuota(
    job(),
    async (url, init) => {
      seen = { url, init };
      return reply(
        200,
        body([
          { type: "TIME_LIMIT", unit: 5, number: 1, percentage: 40 },
          {
            type: "TOKENS_LIMIT",
            unit: 3,
            number: 5,
            percentage: 12,
            nextResetTime: RESET_5H,
          },
          {
            type: "TOKENS_LIMIT",
            unit: 6,
            number: 1,
            percentage: 63.5,
            nextResetTime: RESET_WEEK,
          },
        ]),
      )();
    },
    () => 1000,
  );
  assert.equal(
    seen.url,
    "https://open.bigmodel.cn/api/monitor/usage/quota/limit",
  );
  assert.equal(seen.init.headers.Authorization, "secret-key");
  // Never follows a redirect (the key would go elsewhere).
  assert.equal(seen.init.redirect, "error");
  assert.equal(snap.status, "ok");
  assert.equal(snap.provider, "glm-coding");
  assert.equal(snap.via, "http");
  assert.deepEqual(snap.plan, { name: "GLM max", source: "identity-label" });
  assert.deepEqual(snap.windows, [
    { kind: "five_hour", usedPercent: 12, resetsAt: RESET_5H },
    { kind: "weekly", usedPercent: 63.5, resetsAt: RESET_WEEK },
  ]);
  assert.equal(snap.fetchedAt, 1000);
  // Valid for the server's copy, kept as the identity's newest, and the key
  // is nowhere in it.
  assert.ok(parseQuotaSnapshot(snap));
  assert.equal(quotaOf("p-glm"), snap);
  assert.ok(!JSON.stringify(snap).includes("secret-key"));
});

test("fromGlmQuota: nothing used yet has no reset time (null, not a guess)", () => {
  const snap = fromGlmQuota(
    "p",
    "GLM pro",
    JSON.parse(
      body([
        { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 0 },
        {
          type: "TOKENS_LIMIT",
          unit: 6,
          number: 1,
          percentage: 0,
        },
      ]),
    ),
  );
  assert.equal(snap.status, "ok");
  assert.deepEqual(
    snap.windows.map((w) => [w.kind, w.usedPercent, w.resetsAt]),
    [
      ["five_hour", 0, null],
      ["weekly", 0, null],
    ],
  );
});

test("fromGlmQuota: entries without number/unit fill by reset time (nearer = 5 h)", () => {
  const snap = fromGlmQuota(
    "p",
    "GLM",
    JSON.parse(
      body([
        { type: "TOKENS_LIMIT", percentage: 70, nextResetTime: RESET_WEEK },
        { type: "TOKENS_LIMIT", percentage: 5, nextResetTime: RESET_5H },
      ]),
    ),
  );
  assert.deepEqual(
    snap.windows.map((w) => [w.kind, w.usedPercent]),
    [
      ["five_hour", 5],
      ["weekly", 70],
    ],
  );
  // A known window is not overwritten by the fallback.
  const mixed = fromGlmQuota(
    "p",
    "GLM",
    JSON.parse(
      body([
        { type: "TOKENS_LIMIT", percentage: 70, nextResetTime: RESET_WEEK },
        {
          type: "TOKENS_LIMIT",
          unit: 3,
          number: 5,
          percentage: 9,
          nextResetTime: RESET_5H,
        },
      ]),
    ),
  );
  assert.deepEqual(
    mixed.windows.map((w) => [w.kind, w.usedPercent]),
    [
      ["five_hour", 9],
      ["weekly", 70],
    ],
  );
  // Seconds are read as seconds.
  const secs = fromGlmQuota(
    "p",
    "GLM",
    JSON.parse(
      body([
        {
          type: "TOKENS_LIMIT",
          unit: 3,
          number: 5,
          percentage: 1,
          nextResetTime: RESET_5H / 1000,
        },
      ]),
    ),
  );
  assert.equal(secs.windows[0].resetsAt, RESET_5H);
});

test("fetchGlmQuota: HTTP failure, non-JSON, provider error, timeout → 数据不可用", async () => {
  resetQuota();
  const http = await fetchGlmQuota(job(), reply(401, "{}"));
  assert.equal(http.status, "error");
  assert.equal(http.reason, "GLM 额度数据不可用：HTTP 401");
  assert.deepEqual(http.windows, []);
  assert.ok(parseQuotaSnapshot(http));

  const html = await fetchGlmQuota(job(), reply(200, "<html>busy</html>"));
  assert.equal(html.status, "error");
  assert.match(html.reason!, /不是 JSON/);

  const denied = await fetchGlmQuota(
    job(),
    reply(
      200,
      JSON.stringify({ code: 1001, msg: "令牌已过期\n", success: false }),
    ),
  );
  assert.equal(denied.status, "error");
  assert.equal(denied.reason, "GLM 额度数据不可用：令牌已过期");

  const empty = await fetchGlmQuota(job(), reply(200, body([])));
  assert.equal(empty.status, "unavailable");

  const down = await fetchGlmQuota(job(), async () => {
    throw new Error("ECONNRESET secret-key");
  });
  assert.equal(down.reason, "GLM 额度数据不可用：网络错误");
  assert.ok(!JSON.stringify(down).includes("secret-key"));

  const noKey = await fetchGlmQuota(job({ apiKey: "" }), async () => {
    throw new Error("must not be called");
  });
  assert.equal(noKey.reason, "GLM 额度数据不可用：身份没有 API key");
  resetQuota();
});

test("fetchGlmQuota: a real timeout, the key out of provider messages, a size cap", async () => {
  resetQuota();
  // Answers only when aborted: the timeout must fire.
  let aborted = false;
  const started = Date.now();
  const slow = await fetchGlmQuota(
    job(),
    (_url, init) =>
      new Promise((_res, rej) =>
        init.signal.addEventListener("abort", () => {
          aborted = true;
          rej(Object.assign(new Error("aborted"), { name: "AbortError" }));
        }),
      ),
    () => Date.now(),
    50,
  );
  assert.ok(aborted);
  assert.ok(Date.now() - started < 2000);
  assert.equal(slow.reason, "GLM 额度数据不可用：查询超时");

  // A provider echoing the key back: never stored.
  const echoed = await fetchGlmQuota(
    job(),
    reply(
      200,
      JSON.stringify({
        code: 401,
        success: false,
        msg: "bad token secret-key",
      }),
    ),
  );
  assert.equal(echoed.reason, "GLM 额度数据不可用：bad token ***");
  assert.ok(!JSON.stringify(echoed).includes("secret-key"));

  // More than 64 KiB (streamed body): refused, the stream cancelled.
  let cancelled = false;
  const big = await fetchGlmQuota(job(), async () => ({
    ok: true,
    status: 200,
    text: async () => {
      throw new Error("must stream");
    },
    body: new ReadableStream<Uint8Array>({
      pull(c) {
        c.enqueue(new Uint8Array(16 * 1024).fill(32));
      },
      cancel() {
        cancelled = true;
      },
    }),
  }));
  assert.equal(big.reason, "GLM 额度数据不可用：返回内容过大");
  assert.ok(cancelled);
  // A small streamed answer is read normally.
  const bytes = new TextEncoder().encode(
    body([{ type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 7 }]),
  );
  const ok = await fetchGlmQuota(job(), async () => ({
    ok: true,
    status: 200,
    text: async () => "",
    body: new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes);
        c.close();
      },
    }),
  }));
  assert.equal(ok.status, "ok");
  assert.equal(ok.windows[0].usedPercent, 7);
  resetQuota();
});
