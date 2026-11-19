/**
 * P1-08 core browser test (完成标志): the real start command, `daisy open`,
 * one full conversation with a fake harness, one approval card handled in
 * the page — plus the PIN banner (D-36), the session notifications and the
 * settings page of stage 1.
 *
 * - Starts `packages/daisy/src/main.ts` (one process, P1-02) with its own
 *   data directory (DAISY_DATA) and home (HOME), the fake harness
 *   (tests/fixtures/agent.cjs) for all three CLIs, and the page exported
 *   by `npm run build:web` (apps/app/dist).
 * - `daisy open --print` (P1-07's real command, same data directory)
 *   prints `http://127.0.0.1:<port>/#code=…`; the browser opens it.
 *
 *   npm run build:web && npm run test:e2e
 *   CHROME_BIN=/path/to/chrome npm run test:e2e   (default: the system Chrome)
 */
const { chromium } = require("playwright");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const { chromePath, daisyOpen, waitForFile, e2eEnv } = require("./e2e-open.cjs");

const root = path.resolve(__dirname, "..");
const PIN = "135792468";

(async () => {
  assert.ok(
    fs.existsSync(path.join(root, "apps/app/dist/index.html")),
    "先运行 npm run build:web（网页由 Daisy 进程提供，要先导出）",
  );
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "daisy-e2e-"));
  const home = path.join(tmp, "home"),
    data = path.join(tmp, "data"),
    project = path.join(home, "project");
  fs.mkdirSync(project, { recursive: true });
  // The fake Codex shows this image in its answer when it is in the workspace.
  fs.writeFileSync(
    path.join(project, "daisy-test.png"),
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6SVEAAAAASUVORK5CYII=",
      "base64",
    ),
  );
  const fake = path.join(root, "tests/fixtures/agent.cjs");
  const env = {
    ...e2eEnv(),
    HOME: home,
    DAISY_DATA: data,
    DAISY_CLAUDE_BIN: fake,
    DAISY_CODEX_BIN: fake,
    DAISY_KIMI_BIN: fake,
  };
  delete env.DAISY_PORT;
  delete env.PORT;
  delete env.HOST;
  const server = spawn(
    process.execPath,
    ["--import", "tsx", "packages/daisy/src/main.ts"],
    { cwd: root, env, stdio: ["ignore", "inherit", "inherit"] },
  );
  const exited = new Promise((r) => server.once("exit", r));
  let browser;
  try {
    await waitForFile(path.join(data, "runtime.json"), 30000, exited);
    const link = daisyOpen(data, env);
    assert.match(link, /^http:\/\/127\.0\.0\.1:\d+\/#code=/);
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
    page.on("console", (m) => {
      if (m.type() === "error" && /Content Security Policy/.test(m.text()))
        errors.push(m.text());
    });
    fs.mkdirSync(path.join(root, "artifacts"), { recursive: true });
    const shot = (name) =>
      page.screenshot({ path: path.join(root, "artifacts", name), fullPage: true });

    // ── daisy open: the one-time code in the link logs the page in ────────
    await page.goto(link);
    await page.getByTestId("new-session").waitFor();
    // The code is gone from the address bar (never kept, never reused).
    assert.doesNotMatch(page.url(), /code=/);
    await shot("p1-08-open.png");

    // ── D-36: no PIN → the banner on every page; set it in 设置 ───────────
    const banner = page.getByTestId("pin-banner");
    const pinRoutes = await page.evaluate(async () => {
      const t = JSON.parse(sessionStorage.getItem("daisy.auth.v1")).token;
      const r = await fetch("/api/pin", { headers: { authorization: `Bearer ${t}` } });
      return r.status;
    });
    if (pinRoutes === 200) {
      await banner.waitFor();
      assert.match(await banner.innerText(), /先设置 PIN，AI 才会开始工作/);
      await page.getByTestId("pin-banner-set").click();
      await page.getByTestId("settings-pin").waitFor();
      await page.getByTestId("pin-open").click();
      await page.getByTestId("pin-new").fill(PIN);
      await page.getByTestId("pin-again").fill(PIN);
      await page.getByTestId("pin-save").click();
      await page.getByTestId("pin-state").getByText("已设置").waitFor();
      await banner.waitFor({ state: "detached" });
      // Back to the overview (设置 has its own directory picker).
      await page.getByRole("button", { name: "▦ 工作概览", exact: true }).click();
    } else {
      // Before P1-05's routes: no PIN state at all, no banner.
      assert.equal(await banner.count(), 0);
      console.log(`(no PIN routes: GET /api/pin → ${pinRoutes}; skipping the PIN part)`);
    }

    // ── a session with the fake Codex in ~/project ────────────────────────
    await page.getByTestId("new-session").click();
    await page.getByTestId("new-session-agent-codex").click();
    await page.getByTestId("session-title").fill("P1-08 验收 · 一轮对话");
    await page.getByTestId("workspace-toggle").click();
    await page
      .getByRole("button", { name: "打开文件夹 project", exact: true })
      .click();
    await page.getByText(/正在浏览：.*project/).waitFor();
    await page.getByRole("button", { name: "使用此路径", exact: true }).click();
    await page.getByTestId("create-session").click();
    await page.getByTestId("composer").fill("请审阅任务并输出一张图。");
    await page.getByTestId("send-message").click();

    // ── the approval card, handled in 「审批」 ─────────────────────────────
    await page.getByTestId("approval-card").waitFor({ timeout: 30000 });
    // The session row says it waits for an approval (notification).
    await page.getByTestId("session-notice").getByText(/待审批/).waitFor({ timeout: 15000 });
    await shot("p1-08-approval.png");
    await page.getByTestId("approval-open-inbox").click();
    await page
      .getByTestId("approvals-panel")
      .getByRole("button", { name: "允许本次", exact: true })
      .click();
    await page.getByRole("button", { name: "关闭 ✕", exact: true }).click();

    // ── the turn completes: the answer, its image ─────────────────────────
    await page.getByText("审阅完成", { exact: true }).waitFor({ timeout: 30000 });
    await page.waitForTimeout(500);
    assert.ok(
      await page
        .locator("img")
        .evaluateAll((images) =>
          images.some((i) => i.complete && i.naturalWidth > 0),
        ),
      "the turn's image is shown",
    );
    await shot("p1-08-conversation.png");

    // ── notifications: 一轮结束 and the handled card ──────────────────────
    await page.getByTestId("notifications-open").click();
    const panel = page.getByTestId("notifications-panel");
    await panel.getByTestId("notification-ai_private_message").waitFor({ timeout: 15000 });
    assert.match(
      await panel.getByTestId("notification-ai_private_message").innerText(),
      /这一轮完成了/,
    );
    await panel.getByTestId("notification-approval").first().getByText("已处理").waitFor();
    await shot("p1-08-notifications.png");
    await panel.getByRole("button", { name: "关闭 ✕", exact: true }).click();

    // ── 设置: the stage-1 blocks ──────────────────────────────────────────
    await page.getByRole("button", { name: "⚙ 设置", exact: true }).click();
    for (const id of [
      "settings-identities",
      "settings-workspaces",
      "settings-access",
      "settings-autostart",
      "settings-update",
    ])
      await page.getByTestId(id).waitFor();
    await page.getByTestId("harness-installed").getByText("Codex").waitFor();
    // 开机自启 reads GET /api/autostart (not toggled here: on Linux that
    // would touch this account's real systemd user instance).
    await page
      .getByTestId("settings-autostart")
      .locator('[data-testid="autostart-toggle"], [data-testid="autostart-unsupported"]')
      .first()
      .waitFor();
    await page.getByTestId("workspace-list").getByText(project).waitFor();
    assert.match(
      await page.getByTestId("access-summary").innerText(),
      /本机：http:\/\/127\.0\.0\.1:\d+ · 对外面已关闭/,
    );
    if (pinRoutes === 200) {
      // A PIN-guarded change asks for the PIN, and a wrong one is refused.
      await page.getByTestId("access-passcode-on").click();
      await page.getByTestId("pin-dialog").waitFor();
      await page.getByTestId("pin-dialog-input").fill("000000");
      await page.getByTestId("pin-dialog-submit").click();
      await page.getByTestId("pin-dialog").getByText(/PIN 不对/).waitFor();
      await page.getByTestId("pin-dialog-input").fill(PIN);
      await page.getByTestId("pin-dialog-submit").click();
      await page.getByTestId("pin-dialog").waitFor({ state: "detached" });
      await page.getByTestId("access-summary").getByText(/需要一次性口令/).waitFor();
    }
    // No machine table, no accounts: gone from the page.
    for (const gone of ["node-table", "login-password"])
      assert.equal(await page.getByTestId(gone).count(), 0, gone);
    await shot("p1-08-settings.png");

    // ── phone width: nothing wider than the screen ────────────────────────
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(300);
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await shot("p1-08-settings-mobile.png");
    assert.deepEqual(errors, []);
    console.log(
      "P1-08 e2e passed: daisy open → one-time code → " +
        (pinRoutes === 200 ? "PIN banner → PIN set → " : "") +
        "session → fake Codex turn → approval card answered → answer + image → notifications → settings.",
    );
  } catch (e) {
    // Where it stopped, for whoever reads the failure.
    await browser
      ?.contexts()[0]
      ?.pages()[0]
      ?.screenshot({ path: path.join(root, "artifacts", "p1-08-failed.png"), fullPage: true })
      .catch(() => {});
    throw e;
  } finally {
    await browser?.close();
    if (server.exitCode === null) server.kill("SIGTERM");
    await exited;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
