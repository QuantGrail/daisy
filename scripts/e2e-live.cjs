/**
 * P1-08: 登录已改成一次性口令（scripts/e2e-open.cjs）。P6-25：实时面板的定时器一行带来源（「定时器（Claude Code）：…」），按新写法找，不再失败。
 */
// Browser check for online sessions and the trace bar:
// online badge and its panel, a turn the Agent starts by itself (timer),
// the trace bar's step line, /compact feedback, model chip, going offline.
const { chromium } = require("playwright");
const { chromePath, openLink, e2eEnv } = require("./e2e-open.cjs");
const { spawn } = require("node:child_process");
const assert = require("node:assert/strict");
(async () => {
  const server = spawn(
    process.execPath,
    ["--import", "tsx", "scripts/fixture-server.ts"],
    {
      stdio: ["ignore", "inherit", "inherit", "ipc"],
      // Long enough to see the timer pending before it fires.
      env: { ...e2eEnv(), DAISY_FIXTURE_WAKE_MS: "4000" },
    },
  );
  let browser, page;
  try {
    const info = await new Promise((resolve, reject) => {
      server.once("message", resolve);
      server.once("exit", () => reject(Error("fixture stopped")));
    });
    browser = await chromium.launch({
      executablePath: chromePath(),
      headless: true,
      args: ["--no-sandbox"],
    });
    page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const shot = async (name) => {
      if (process.env.E2E_SHOTS)
        await page.screenshot({ path: `${process.env.E2E_SHOTS}/${name}.png` });
    };
    // P1-08: no password — the link `daisy open` prints (one-time code).
    await page.goto(openLink(info));
    await page.getByTestId("new-session").click();
    await page
      .getByRole("button", { name: "Claude Code", exact: true })
      .click();
    await page.getByTestId("session-title").fill("Live");
    await page.getByTestId("create-session").click();
    const composer = page.getByTestId("composer");
    const badge = page.getByTestId("live-badge");
    const detail = page.getByTestId("trace-detail");
    // A fresh conversation is offline.
    await badge.getByText("离线").waitFor();
    // 1. First turn: the trace bar names the step while it waits.
    await composer.fill("Hello");
    await page.getByTestId("send-message").click();
    await page.getByTestId("chat-working").waitFor();
    await detail.getByText(/等待你授权：Bash/).waitFor();
    await shot("1-trace-waiting");
    // The 「审批」 page path (D-39: the chat card answers it too).
    await page.getByTestId("approval-open-inbox").click();
    await page
      .getByTestId("approvals-panel")
      .getByRole("button", { name: "允许本次", exact: true })
      .click();
    await page.getByRole("button", { name: "关闭 ✕", exact: true }).click();
    await page.getByTestId("chat-working").waitFor({ state: "hidden" });
    // Online now, the model the Agent reported.
    await badge.getByText("在线").waitFor();
    await page
      .getByTestId("model-chip")
      .getByText(/fixture-model/)
      .waitFor();
    await detail.getByText(/空闲 · 上一轮/).waitFor();
    // The finished turn is one summary line in the stream.
    await page.getByTestId("activity-summary").first().waitFor();
    // 2. A timer the Agent set: pending, then a turn of its own.
    await composer.fill("WAKE_TEST");
    await page.getByTestId("send-message").click();
    // The wording: 后台 N 项 (native timers and Daisy's together).
    await badge.getByText(/在线 · 后台 1 项/).waitFor();
    await badge.click();
    await page.getByTestId("live-panel").waitFor();
    // The row names whose timer it is (「定时器（Claude Code）：…」).
    await page.getByText(/◷ 定时器(（[^）]*）)?：检查构建/).waitFor();
    await shot("2-live-panel");
    await badge.click();
    await page.getByTestId("live-panel").waitFor({ state: "hidden" });
    const marker = page.getByTestId("wake-marker");
    await marker.getByText("AI 自己继续 · 定时器到点：检查构建").waitFor();
    await page.getByText("Woke up by timer", { exact: true }).waitFor();
    await page.getByTestId("chat-working").waitFor({ state: "hidden" });
    await badge.getByText("在线", { exact: true }).waitFor();
    await shot("3-wake-turn");
    // 3. /compact: the Agent's own, with before → after in the panel, the
    // conversation and the ring.
    await composer.fill("/compact");
    await page.getByTestId("slash-compact").click();
    await page
      .getByRole("button", { name: "确认压缩上下文", exact: true })
      .click();
    await page
      .getByTestId("command-result")
      .getByText(/已压缩上下文：50\.0K → 5\.0K tokens/)
      .waitFor();
    await page.getByRole("button", { name: "关闭", exact: true }).click();
    await page
      .getByTestId("compact-notice")
      .getByText(/已压缩上下文：50\.0K → 5\.0K tokens（1\.2 秒 · 手动压缩）/)
      .waitFor();
    assert.match(await page.getByTestId("context-ring").innerText(), /3%/);
    await shot("4-compacted");
    // 4. The trace bar opens the full track (large step circles).
    await page.getByTestId("trace-toggle").click();
    await page.getByTestId("trace-expanded").waitFor();
    await page.getByTestId("activity-dot").first().waitFor();
    await shot("5-trace-open");
    await page.getByTestId("trace-toggle").click();
    // 5. Offline on request.
    await badge.click();
    await page.getByTestId("go-offline").click();
    await badge.getByText("离线").waitFor();
    await badge.click();
    await page.getByText("已按你的要求下线").waitFor();
    await shot("6-offline");
    assert.deepEqual(errors, []);
    console.log(
      "Live browser test passed: online badge + panel, Agent-started turn, trace bar step line, /compact feedback, model chip, offline.",
    );
  } catch (e) {
    if (page) await page.screenshot({ path: "/tmp/e2e-live-fail.png" });
    console.error(e);
    process.exitCode = 1;
  } finally {
    await browser?.close();
    server.kill();
  }
})();
