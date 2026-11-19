const { chromium } = require("playwright");
const { chromePath, openLink, e2eEnv } = require("./e2e-open.cjs");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const assert = require("node:assert/strict");
(async () => {
  const server = spawn(
    process.execPath,
    ["--import", "tsx", "scripts/fixture-server.ts"],
    { stdio: ["ignore", "inherit", "inherit", "ipc"], env: e2eEnv() },
  );
  let browser;
  try {
    const info = await new Promise((resolve, reject) => {
      server.once("message", resolve);
      server.once("exit", () => reject(Error("Fixture backend stopped")));
    });
    browser = await chromium.launch({
      executablePath: chromePath(),
      headless: true,
      args: ["--no-sandbox"],
    });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 980 },
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    // The strict CSP must not block anything the app needs.
    page.on("console", (m) => {
      if (m.type() === "error" && /Content Security Policy/.test(m.text()))
        errors.push(m.text());
    });
    // P1-08: no password — the link `daisy open` prints (one-time code).
    await page.goto(openLink(info));
    // The Agent login card (login-<agent>) is a host component
    // (DaisyAgentLogin) the DaisyApp settings no longer mount; identities
    // are added there with 「＋ 添加身份」.
    await page.getByTestId("new-session").click();
    await page.getByRole("button", { name: "Codex", exact: true }).click();
    await page.getByTestId("session-title").fill("集成验收 · 图片与审批");
    await page.getByTestId("workspace-toggle").click();
    await page
      .getByRole("button", { name: "打开文件夹 sample-project", exact: true })
      .click();
    await page.getByText(/正在浏览：.*sample-project/).waitFor();
    await page.getByRole("button", { name: "↑ 上一级", exact: true }).click();
    await page
      .getByRole("button", { name: "打开文件夹 sample-project", exact: true })
      .waitFor();
    await page.getByRole("button", { name: "使用此路径", exact: true }).click();
    await page.getByTestId("create-session").click();
    await page.getByTestId("composer").fill("请审阅任务并输出一张图。");
    await page
      .getByRole("button", { name: "查看发送内容", exact: true })
      .click();
    await page
      .getByText("将要发给 Agent 的内容（作为你的消息发送）", { exact: true })
      .waitFor();
    assert.equal(
      await page
        .getByTestId("composer")
        .evaluate((el) => getComputedStyle(el).outlineStyle),
      "none",
    );
    await page
      .getByRole("button", { name: "收起发送内容", exact: true })
      .click();
    await page.getByTestId("send-message").click();
    await page.getByTestId("approval-card").waitFor();
    // the running turn is on the trace bar; its full view opens
    // with the large step circles.
    await page
      .getByTestId("trace-detail")
      .getByText(/等待你授权/)
      .waitFor();
    await page.getByTestId("trace-toggle").click();
    await page.getByTestId("activity-track").waitFor();
    await page.getByTestId("activity-current").waitFor();
    await page
      .getByRole("button", { name: "收起执行轨迹", exact: true })
      .click();
    await page
      .getByRole("button", { name: /^展开执行轨迹（\d+ 个步骤）$/ })
      .click();
    await page.getByRole("button", { name: "回到第一步", exact: true }).click();
    await page
      .getByRole("button", { name: "发送内容审计 · 已完成", exact: true })
      .click();
    await page.getByTestId("activity-detail").waitFor();
    await page.getByText(/systemPromptOverride/).waitFor();
    await page
      .getByRole("button", { name: "发送内容审计 · 已完成", exact: true })
      .click();
    fs.mkdirSync("artifacts", { recursive: true });
    await page.screenshot({
      path: "artifacts/web-approval.png",
      fullPage: true,
    });
    // UI disappearance must not terminate the process or approval.
    await context.setOffline(true);
    await page.waitForTimeout(800);
    await context.setOffline(false);
    await page.reload();
    await page
      .getByText("集成验收 · 图片与审批", { exact: true })
      .first()
      .click();
    await page.getByTestId("approval-card").waitFor();
    // D-39: a permission prompt is answered right in the chat card (the
    // other scripts answer it on the 「审批」 page).
    await page
      .getByTestId("approval-card")
      .getByRole("button", { name: "允许本次", exact: true })
      .click();
    await page.getByText("审阅完成", { exact: true }).waitFor();
    await page.getByText(/daisy-test.png ·/).waitFor();
    await page.waitForTimeout(800);
    assert.ok(
      await page
        .locator("img")
        .evaluateAll((images) =>
          images.some((i) => i.complete && i.naturalWidth > 0),
        ),
    );
    await page.screenshot({
      path: "artifacts/web-conversation.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: "artifacts/mobile-conversation.png",
      fullPage: true,
    });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    const chooserPromise = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "＋ 附件", exact: true }).click();
    const chooser = await chooserPromise;
    await chooser.setFiles({
      name: "browser-input.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Browser attachment acceptance"),
    });
    await page.getByText("browser-input.txt ×", { exact: true }).waitFor();
    await page.getByTestId("composer").fill("WAIT_UNTIL_CANCEL");
    await page.getByTestId("send-message").click();
    await page.getByRole("button", { name: "■ 停止", exact: true }).waitFor();
    await page.getByRole("button", { name: "■ 停止", exact: true }).click();
    await page.getByText("已中断", { exact: true }).first().waitFor();
    await page.setViewportSize({ width: 1440, height: 980 });
    await page.getByTestId("new-session").click();
    await page.getByRole("button", { name: "Codex", exact: true }).click();
    await page.getByTestId("session-title").fill("自动创建工作目录");
    await page.getByTestId("workspace-toggle").click();
    await page
      .getByRole("button", { name: "打开文件夹 sample-project", exact: true })
      .waitFor();
    await page
      .getByTestId("workspace-path")
      .fill("~/created-from-browser/项目");
    await page.getByTestId("create-session").click();
    await page.getByTestId("composer").waitFor();
    await page.getByTestId("new-session").click();
    await page.getByRole("button", { name: "Codex", exact: true }).click();
    await page.getByTestId("workspace-toggle").click();
    await page
      .getByRole("button", {
        name: "打开文件夹 created-from-browser",
        exact: true,
      })
      .waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: "artifacts/mobile-workspace-picker.png",
      fullPage: true,
    });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    assert.deepEqual(errors, []);
    console.log(
      "Full browser test passed: real UI → HTTP → worker → fixture agent → approval → reconnect → Markdown + image → upload → cancellation.",
    );
  } finally {
    await browser?.close();
    server.kill("SIGTERM");
    await new Promise((r) => server.once("exit", r));
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
