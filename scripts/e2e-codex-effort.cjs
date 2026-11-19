/**
 * P1-08: 登录已改成一次性口令（scripts/e2e-open.cjs）。已知失败：在第二次打开 /model 时失败（slash-model 按钮反复重渲染、点不到）。
 * 在 P1-03 基线（origin/p1-03-local-auth，只换了登录）上同样失败，与登录和
 * 本地网页的改动无关，留给对应功能的维护者查。
 */
// Browser check for Codex's /model panel, against the fake CLI
// serving Codex 0.157.1's real model/list (no tokens): before the catalog
// is read a fallback list; after it, the selected model's own efforts
// (Astra: max + ultra, Luna: max only) and the Fast tier; an unsupported
// choice goes back to default when the model changes; the saved choice
// reaches the Agent and shows on the model chip.
// E2E_SHOTS=<dir> saves screenshots (codex-effort-*.png).
const { chromium } = require("playwright");
const { chromePath, openLink, e2eEnv } = require("./e2e-open.cjs");
const { spawn } = require("node:child_process");
const { resolve, join } = require("node:path");
const assert = require("node:assert/strict");
(async () => {
  const server = spawn(
    process.execPath,
    ["--import", "tsx", "scripts/fixture-server.ts"],
    {
      stdio: ["ignore", "inherit", "inherit", "ipc"],
      env: {
        ...e2eEnv(),
        DAISY_FIXTURE_CODEX_CATALOG: resolve(
          "tests/fixtures/codex-model-list.json",
        ),
      },
    },
  );
  const shot = (name) =>
    process.env.E2E_SHOTS
      ? page.screenshot({
          path: join(process.env.E2E_SHOTS, `codex-effort-${name}.png`),
        })
      : Promise.resolve();
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
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    // The catalog operation starts a runner process: slow on a busy host.
    page.setDefaultTimeout(60000);
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    // P1-08: no password — the link `daisy open` prints (one-time code).
    await page.goto(openLink(info));
    await page.getByTestId("new-session").click();
    await page.getByRole("button", { name: "Codex", exact: true }).click();
    await page.getByTestId("session-title").fill("Codex effort");
    await page.getByTestId("create-session").click();
    const composer = page.getByTestId("composer");
    const openModel = async () => {
      await composer.fill("/model");
      await page.getByTestId("slash-model").click();
      await page
        .getByRole("button", { name: "读取原生模型列表", exact: true })
        .waitFor();
    };
    const button = (name) => page.getByRole("button", { name, exact: true });
    const visible = async (name) => (await button(name).count()) > 0;
    await openModel();
    // Before the catalog: the fallback (max, no ultra, no speed row).
    await page.getByText(/读取原生模型列表后，按所选模型显示/).waitFor();
    for (const e of ["low", "medium", "high", "xhigh", "max"])
      assert.ok(await visible(e), `fallback ${e}`);
    assert.equal(await visible("ultra"), false);
    assert.equal(await visible("Fast"), false);
    await shot("1-fallback");
    await button("读取原生模型列表").click();
    await button("GPT-6-Astra").click();
    await button("ultra").waitFor();
    for (const e of ["low", "medium", "high", "xhigh", "max", "ultra"])
      assert.ok(await visible(e), `astra ${e}`);
    await page.getByText("速度", { exact: true }).waitFor();
    assert.ok(await visible("Fast"));
    assert.ok(await visible("标准"));
    await button("ultra").click();
    await page
      .getByTestId("effort-description")
      .getByText(/automatic task delegation/)
      .waitFor();
    await button("Fast").click();
    await page
      .getByTestId("tier-description")
      .getByText(/2x speed, increased usage/)
      .waitFor();
    await shot("2-astra-ultra-fast");
    // Luna lists no ultra: the choice goes back to default; Fast stays.
    await button("GPT-6-Luna").click();
    await page.getByRole("textbox", { name: "模型" }).waitFor();
    assert.equal(
      await page.getByRole("textbox", { name: "模型" }).inputValue(),
      "gpt-6-luna",
    );
    assert.equal(await visible("ultra"), false);
    assert.ok(await visible("max"));
    await page.getByTestId("effort-description").waitFor({ state: "hidden" });
    await page.getByTestId("tier-description").waitFor();
    await shot("3-luna");
    await button("GPT-6-Astra").click();
    await button("ultra").click();
    await button("保存设置").click();
    await page.getByText(/只改了这个会话/).waitFor();
    await button("关闭").click();
    await page
      .getByTestId("model-chip")
      .getByText(/gpt-6-astra · ultra · Fast/)
      .waitFor();
    // The next turn runs with it: the chip shows it as in use.
    await composer.fill("Hello");
    await page.getByTestId("send-message").click();
    await page
      .getByTestId("model-chip")
      .getByText(/^gpt-6-astra · ultra · Fast$/)
      .waitFor({ timeout: 20000 });
    await openModel();
    await page.getByText(/当前实际使用：.*ultra · Fast/).waitFor();
    // Reopened: the saved choice is selected.
    await shot("4-saved");
    // The identity's permissions panel does not take this conversation's
    // tier into the identity (review #3).
    await button("关闭").click();
    await composer.fill("/permissions");
    await page.getByTestId("slash-permissions").click();
    await button("保存设置").click();
    await page.getByText(/后续轮次使用新设置/).waitFor();
    const identity = await page.evaluate(async () => {
      const { token } = JSON.parse(sessionStorage.getItem("daisy.auth.v1"));
      const r = await fetch("/api/catalog", {
        headers: { Authorization: `Bearer ${token}` },
      });
      return (await r.json()).profiles.find((p) => p.agent === "codex");
    });
    assert.equal(identity.serviceTier, undefined);
    await button("关闭").click();
    await openModel();
    await page.getByTestId("tier-description").waitFor();
    // Phone width: the chips wrap, nothing overflows.
    await page.setViewportSize({ width: 390, height: 844 });
    await shot("5-phone");
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    assert.deepEqual(errors, []);
    console.log(
      "Codex effort browser passed: fallback, per-model efforts (ultra), Fast, reset on model change, saved and in use.",
    );
  } catch (e) {
    if (page)
      await page.screenshot({
        path: join(
          process.env.E2E_SHOTS || "artifacts",
          "codex-effort-failure.png",
        ),
      });
    throw e;
  } finally {
    await browser?.close();
    server.kill("SIGTERM");
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
