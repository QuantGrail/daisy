// Browser check for the context ring, its bubble and the identity's
// auto-compact threshold, against the fake CLI (no tokens):
// the ring is used / Claude's reported trigger point; the bubble has the
// five rows; a tap outside only closes it (the control under it does not
// react); the identity setting saves, the online AI restarts with it and
// the ring follows the new trigger point.
// E2E_SHOTS=<dir> saves screenshots (after-8-*.png).
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
      env: {
        ...e2eEnv(),
        DAISY_FIXTURE_USAGE: "ok",
        // A Claude Code new enough for --autocompact (the auto-compact threshold gates on it).
        DAISY_FIXTURE_CLI_VERSION: "2.1.316",
      },
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
    const shot = async (name, opts = {}) => {
      if (process.env.E2E_SHOTS)
        await page.screenshot({
          path: `${process.env.E2E_SHOTS}/after-8-${name}.png`,
          ...opts,
        });
    };
    // P1-08: no password — the link `daisy open` prints (one-time code).
    await page.goto(openLink(info));
    await page.getByTestId("new-session").click();
    await page
      .getByRole("button", { name: "Claude Code", exact: true })
      .click();
    await page.getByTestId("session-title").fill("上下文圆环");
    await page.getByTestId("create-session").click();
    const composer = page.getByTestId("composer");
    const ring = page.getByTestId("context-ring");
    // Before any message: 「—」, unavailable with the reason.
    await ring.getByText("—").waitFor();
    await composer.fill("Hello");
    await page.getByTestId("send-message").click();
    // The 「审批」 page path (D-39: the chat card answers it too).
    await page.getByTestId("approval-open-inbox").click();
    await page
      .getByTestId("approvals-panel")
      .getByRole("button", { name: "允许本次", exact: true })
      .click();
    await page.getByRole("button", { name: "关闭 ✕", exact: true }).click();
    await page.getByTestId("chat-working").waitFor({ state: "hidden" });
    // 50K used / Claude's trigger point 167K (window 200K) = 30 %.
    await ring.getByText("30%").waitFor();
    await shot("1-ring");
    await ring.click();
    const bubble = page.getByTestId("context-bubble");
    await bubble.waitFor();
    for (const key of ["plan", "weekly", "five_hour", "cache", "context"])
      await page.getByTestId(`context-row-${key}`).waitFor();
    await bubble.getByText("max", { exact: false }).first().waitFor();
    await bubble.getByText("剩余 45%").waitFor();
    await bubble.getByText("剩余 70%").waitFor();
    await bubble.getByText("80%", { exact: true }).waitFor();
    await bubble.getByText("50K / 167K（30%）").waitFor();
    await bubble.getByText(/Claude 报告的压缩触发点/).waitFor();
    await shot("2-bubble");
    // R3: a tap on the trace toggle under the backdrop only closes the bubble.
    const toggle = page.getByRole("button", { name: "打开执行轨迹大图" });
    const box = await toggle.boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await bubble.waitFor({ state: "hidden" });
    assert.equal(
      await page.getByRole("button", { name: "关闭执行轨迹大图" }).count(),
      0,
      "the tap that closed the bubble must not toggle the trace view",
    );
    // A tap on the composer likewise: the bubble closes, nothing is typed into.
    await ring.click();
    await bubble.waitFor();
    const cbox = await composer.boundingBox();
    await page.mouse.click(cbox.x + 20, cbox.y + cbox.height / 2);
    await bubble.waitFor({ state: "hidden" });
    assert.notEqual(
      await page.evaluate(() => document.activeElement?.dataset?.testid),
      "composer",
      "the composer must not take the closing tap",
    );
    // The identity's threshold (设置 › harness 登录（身份档）; P1-08: no
    // machine cards any more).
    await page.getByRole("button", { name: "⚙ 设置", exact: true }).click();
    await page.getByTestId("settings-identities").waitFor();
    const chip = page
      .locator('[data-testid^="identity-chip-"]')
      .filter({ hasText: "Claude" })
      .first();
    await chip.click();
    const input = page.locator('[data-testid^="auto-compact-input-"]').first();
    await input.waitFor();
    await page
      .locator('[data-testid^="auto-compact-trigger-"]')
      .getByText(/约 167K 时压缩（Claude 报告/)
      .waitFor();
    await input.fill("400");
    await shot("3-setting-edit", { fullPage: true });
    await page.locator('[data-testid^="auto-compact-save-"]').first().click();
    // The online AI restarts by itself (it is idle) and reports 367K.
    await page.getByText("「上下文圆环」：已生效").waitFor({ timeout: 30000 });
    await page
      .locator('[data-testid^="auto-compact-trigger-"]')
      .getByText(/压缩窗口 400K · 约 367K 时压缩/)
      .waitFor({ timeout: 30000 });
    await shot("4-setting-applied", { fullPage: true });
    // Out of range: the CLI's own limits, refused with the reason.
    await input.fill("50");
    await page.locator('[data-testid^="auto-compact-save-"]').first().click();
    await page.getByText(/阈值须在 100K–1000K 之间/).waitFor();
    // Codex without a configured limit (n-codexring): the ring is used /
    // Codex's own default point, 90% of the model window (Codex 0.157.1
    // reports 258400 = 95% of 272K → 244800), and the plan quota comes from
    // account/rateLimits.
    await page.keyboard.press("Escape");
    await page.goto(page.url().split("#")[0]);
    await page.getByTestId("new-session").click();
    await page.getByRole("button", { name: "Codex", exact: true }).click();
    await page.getByTestId("session-title").fill("Codex 圆环");
    await page.getByTestId("create-session").click();
    await ring.getByText("—").waitFor();
    await composer.fill("Hello");
    await page.getByTestId("send-message").click();
    // The 「审批」 page path (D-39: the chat card answers it too).
    await page.getByTestId("approval-open-inbox").click();
    await page
      .getByTestId("approvals-panel")
      .getByRole("button", { name: "允许本次", exact: true })
      .click();
    await page.getByRole("button", { name: "关闭 ✕", exact: true }).click();
    await page.getByTestId("chat-working").waitFor({ state: "hidden" });
    // 31K used / 244.8K = 12.7 %.
    await ring.getByText("≈13%").waitFor();
    await ring.click();
    await bubble.waitFor();
    await bubble.getByText("31K / 245K（≈13%）").waitFor();
    await bubble.getByText(/Codex 默认压缩点（按模型窗口推算）/).waitFor();
    await bubble
      .getByText("ChatGPT Pro Lite", { exact: false })
      .first()
      .waitFor();
    await bubble.getByText("剩余 39%").waitFor();
    await shot("5-codex-bubble");
    await page.keyboard.press("Escape");
    assert.deepEqual(errors, []);
    console.log(
      "Browser: context ring (used / reported trigger point), bubble rows, tap-outside closes without passing through, identity threshold saved, idle restart to the new trigger point, range refused; Codex default point and plan quota — passed.",
    );
  } catch (e) {
    if (page && process.env.E2E_SHOTS)
      await page
        .screenshot({ path: `${process.env.E2E_SHOTS}/after-8-failure.png` })
        .catch(() => {});
    throw e;
  } finally {
    await browser?.close();
    server.kill("SIGTERM");
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
