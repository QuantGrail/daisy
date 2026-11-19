const { chromium } = require("playwright");
const { chromePath, openLink, e2eEnv } = require("./e2e-open.cjs");
const { spawn } = require("node:child_process");
const assert = require("node:assert/strict");
(async () => {
  const server = spawn(
    process.execPath,
    ["--import", "tsx", "scripts/fixture-server.ts"],
    { stdio: ["ignore", "inherit", "inherit", "ipc"], env: e2eEnv() },
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
    page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    });
    const errors = [];
    page.on("pageerror", (e) => {
      errors.push(e.message);
      console.error("PAGE ERROR", e.message);
    });
    // The strict CSP must not block anything the app (or terminal frame) needs.
    page.on("console", (m) => {
      if (m.type() === "error" && /Content Security Policy/.test(m.text()))
        errors.push(m.text());
    });
    // P1-08: no password — the link `daisy open` prints (one-time code).
    await page.goto(openLink(info));
    await page.getByTestId("new-session").waitFor();
    await page.route("**/api/me", (route) => route.abort());
    await page.reload();
    await page.getByTestId("new-session").waitFor();
    assert.ok(
      await page.evaluate(() => sessionStorage.getItem("daisy.auth.v1")),
      "temporary API outage must preserve login",
    );
    await page.unroute("**/api/me");
    // P1-03: the owner is the system account (no "admin" any more).
    await page
      .getByText(require("node:os").userInfo().username, { exact: true })
      .waitFor();
    await page.getByTestId("new-session").click();
    await page.getByRole("button", { name: "Codex", exact: true }).click();
    await page.getByTestId("session-title").fill("Native commands");
    await page.getByTestId("create-session").click();
    const composer = page.getByTestId("composer");
    const command = async (name) => {
      await composer.fill("/" + name);
      await page.getByTestId("slash-" + name).click();
    };
    await composer.fill("/");
    await page.getByTestId("slash-menu").waitFor();
    await page.keyboard.press("Escape");
    await page.getByTestId("slash-menu").waitFor({ state: "hidden" });
    await command("model");
    await page
      .getByRole("button", { name: "读取原生模型列表", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Fixture Model", exact: true })
      .click();
    await page.getByRole("button", { name: "保存设置", exact: true }).click();
    // model / effort for this conversation only.
    await page.getByText(/只改了这个会话/).waitFor();
    await page.getByRole("button", { name: "关闭", exact: true }).click();
    await page
      .getByTestId("model-chip")
      .getByText(/fixture-model/)
      .waitFor();
    await command("config");
    await page.getByRole("button", { name: "读取配置", exact: true }).click();
    await page.getByLabel("原生配置 JSON").fill('{"model":"fixture-model"}');
    await page
      .getByRole("button", { name: "保存并备份配置", exact: true })
      .click();
    await page.getByText(/"saved": true/).waitFor();
    await page.getByRole("button", { name: "关闭", exact: true }).click();
    await composer.fill("WAIT_UNTIL_CANCEL");
    await page.getByTestId("send-message").click();
    // the running turn lives on the trace bar; open its full view.
    await page.getByTestId("trace-toggle").click();
    await page
      .getByRole("button", { name: "输入已交给 Codex · 已完成", exact: true })
      .waitFor();
    await composer.fill("This is an immediate correction");
    await page.getByTestId("steer-message").click();
    await page
      .getByRole("button", {
        name: "追加消息已交给 Agent · 已完成",
        exact: true,
      })
      .waitFor();
    await composer.fill("Queue for next turn");
    await page.getByTestId("send-message").click();
    await page.getByText(/排队 1 条/).waitFor();
    await page.getByRole("button", { name: "移除", exact: true }).click();
    await page.getByText(/排队 1 条/).waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "■ 停止", exact: true }).click();
    await page.getByText("已中断", { exact: true }).first().waitFor();
    await command("terminal");
    await page
      .getByRole("button", { name: "打开原生 CLI", exact: true })
      .click();
    const frame = page.frameLocator('iframe[title="原生 Agent 终端"]');
    await frame.getByText(/OFFICIAL CLI FIXTURE/).waitFor();
    await frame.locator(".xterm-helper-textarea").fill("/help");
    await frame.getByRole("button", { name: "Enter", exact: true }).click();
    await frame.getByText(/CLI received: \/help/).waitFor();
    await page.screenshot({
      path: "artifacts/native-cli-browser.png",
      fullPage: true,
    });
    await page.getByRole("button", { name: "收起", exact: true }).click();
    await command("terminal");
    await page
      .getByRole("button", { name: "打开原生 CLI", exact: true })
      .click();
    await page
      .frameLocator("iframe")
      .getByText(/OFFICIAL CLI FIXTURE/)
      .waitFor();
    await page.getByRole("button", { name: "结束 CLI", exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await command("help");
    await page.screenshot({
      path: "artifacts/mobile-command-center.png",
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
      "Native commands browser passed: palette, models, configuration, steer, queue, CLI input/reconnect, mobile layout.",
    );
  } catch (e) {
    if (page) {
      await page.screenshot({ path: "artifacts/commands-failure.png" });
      for (const f of page.frames())
        console.error(
          "FRAME",
          f.url(),
          (await f.locator("body").innerText()).slice(-5000),
        );
    }
    throw e;
  } finally {
    await browser?.close();
    server.kill("SIGTERM");
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
