/**
 * P1-08: the PIN in the page — the banner while none is set (D-36), setting
 * it, and PIN-guarded settings (passcode, outside face, an outside link)
 * asking for it once and sending the grant (`daisy-pin-grant`).
 *
 * All real: P1-05's routes (GET / POST /api/pin, POST /api/pin/grant; the
 * grant bound to this page's web session), the D-36 gate on (no PIN → no
 * AI turn), the guard's PIN check on PUT /api/access/passcode, PUT
 * /api/access/external and POST /api/web/open-code/external.
 */
const { chromium } = require("playwright");
const { spawn } = require("node:child_process");
const assert = require("node:assert/strict");
const { chromePath, openLink, e2eEnv } = require("./e2e-open.cjs");

(async () => {
  const server = spawn(
    process.execPath,
    ["--import", "tsx", "scripts/fixture-server.ts"],
    {
      stdio: ["ignore", "inherit", "inherit", "ipc"],
      env: { ...e2eEnv(), FIXTURE_PIN: "1" },
    },
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
    const page = await browser.newPage({ viewport: { width: 1280, height: 950 } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    let grantsAsked = 0;
    page.on("request", (r) => {
      if (new URL(r.url()).pathname === "/api/pin/grant") grantsAsked++;
    });
    const granted = [];
    page.on("request", (r) => {
      const g = r.headers()["daisy-pin-grant"];
      if (g) granted.push(`${r.method()} ${new URL(r.url()).pathname}`);
    });

    await page.goto(openLink(info));
    await page.getByTestId("new-session").waitFor();
    // D-36: the banner while no PIN is set.
    const banner = page.getByTestId("pin-banner");
    await banner.getByText("先设置 PIN，AI 才会开始工作").waitFor();
    await page.getByTestId("pin-banner-set").click();
    await page.getByTestId("pin-state").getByText("未设置").waitFor();
    await page.getByTestId("pin-open").click();
    await page.getByTestId("pin-new").fill("246810");
    await page.getByTestId("pin-again").fill("246811");
    await page.getByTestId("pin-save").click();
    await page.getByText("两次输入的新 PIN 不一样").waitFor();
    await page.getByTestId("pin-again").fill("246810");
    await page.getByTestId("pin-save").click();
    await page.getByTestId("pin-state").getByText("已设置").waitFor();
    await banner.waitFor({ state: "detached" });
    // When and through which entry (D-36).
    await page.getByTestId("pin-provenance").getByText(/PIN 于 .* 经本地网页设置/).waitFor();
    await page.getByTestId("pin-history").getByText(/经本地网页设置/).waitFor();

    // The passcode: PIN asked, a wrong one refused, the right one passes the
    // real guard (its PIN check on PUT /api/access/passcode).
    const summary = page.getByTestId("access-summary");
    await summary.getByText(/本机打开网页不需要口令/).waitFor();
    await page.getByTestId("access-passcode-on").click();
    await page.getByTestId("pin-dialog").waitFor();
    await page.getByTestId("pin-dialog-input").fill("000000");
    await page.getByTestId("pin-dialog-submit").click();
    await page.getByTestId("pin-dialog").getByText(/PIN 不对/).waitFor();
    await page.getByTestId("pin-dialog-input").fill("246810");
    await page.getByTestId("pin-dialog-submit").click();
    await page.getByTestId("pin-dialog").waitFor({ state: "detached" });
    await summary.getByText(/打开网页需要一次性口令/).waitFor();
    // Within the grant's life: no second prompt.
    const asked = grantsAsked;
    await page.getByTestId("access-passcode-auto").click();
    await summary.getByText(/本机打开网页不需要口令/).waitFor();
    assert.equal(await page.getByTestId("pin-dialog").count(), 0);
    // The outside face: on (PIN, held), a link for another machine, off (no PIN).
    await page.getByTestId("access-external-edit").click();
    await page.getByTestId("access-external-host").fill("127.0.0.1");
    await page.getByTestId("access-external-save").click();
    await page.getByTestId("access-external-url").getByText(/^https:\/\/127\.0\.0\.1:\d+/).waitFor();
    await summary.getByText(/对外：https:.*TLS/).waitFor();
    await page.getByTestId("access-external-link").click();
    await page
      .getByTestId("access-external-link-box")
      .getByText(/^https:\/\/127\.0\.0\.1:\d+\/#code=/)
      .waitFor();
    assert.equal(grantsAsked, asked, "the held grant was reused");
    await page.getByTestId("access-external-off").click();
    await summary.getByText(/对外面已关闭/).waitFor();
    assert.deepEqual(granted, [
      "PUT /api/access/passcode",
      "PUT /api/access/passcode",
      "PUT /api/access/external",
      "POST /api/web/open-code/external",
    ]);
    await page.screenshot({ path: "artifacts/p1-08-pin.png", fullPage: true });
    assert.deepEqual(errors, []);
    console.log(
      "PIN browser test passed: banner → set PIN (mismatch refused) → history → passcode with PIN (wrong refused) → grant reused → outside face on / link / off.",
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
