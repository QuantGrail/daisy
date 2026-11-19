/**
 * P4-12 (ADR-132): the 「对外」 pages in a phone-width browser — import
 * another Daisy's card (look first: the grouped identity number, checked,
 * then added), see its AI's call waiting, approve it 仅本次 (PIN), then
 * 永久通过 on the next call and find the grant. D-40 ①: the lists and the
 * card inspection come without a PIN; the PIN is asked when adding.
 *
 * All real: the fixture backend (scripts/fixture-server.ts with
 * FIXTURE_SHARING=1) has the PIN set, a public agent on the fake CLI, and
 * another Daisy "B" (its own key and card) whose AI calls that agent over
 * A2A when this driver asks. No model is involved.
 */
const { chromium } = require("playwright");
const { spawn } = require("node:child_process");
const assert = require("node:assert/strict");
const { chromePath, openLink, e2eEnv } = require("./e2e-open.cjs");

const PIN = "246810";

(async () => {
  const server = spawn(process.execPath, ["--import", "tsx", "scripts/fixture-server.ts"], {
    stdio: ["ignore", "inherit", "inherit", "ipc"],
    env: { ...e2eEnv(), FIXTURE_SHARING: "1" },
  });
  let browser;
  try {
    const info = await new Promise((resolve, reject) => {
      server.once("message", resolve);
      server.once("exit", () => reject(Error("Fixture backend stopped")));
    });
    /** B's AI calls the public agent (A2A, returnImmediately). */
    const call = () =>
      new Promise((resolve) => {
        const on = (m) => {
          if (m && m.op === "called") {
            server.off("message", on);
            resolve(m);
          }
        };
        server.on("message", on);
        server.send({ op: "call" });
      });
    browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    // A phone.
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(openLink(info));
    // The phone layout keeps the navigation behind a button.
    const settingsButton = page.getByText("⚙ 设置", { exact: true });
    if (!(await settingsButton.isVisible().catch(() => false))) await page.getByTestId("mobile-nav-open").click();
    await page.getByText("⚙ 设置", { exact: true }).click();
    await page.getByTestId("settings-sharing").waitFor();
    // D-40 ①: the group's lists load without a PIN (no unlock, no dialog).
    assert.equal(await page.getByTestId("sharing-unlock").count(), 0);
    await page.getByTestId("sharing-contacts-empty").waitFor();
    await page.getByTestId(`agent-${info.agentId}`).waitFor();
    await page.getByTestId("sharing-requests-empty").waitFor();
    await page.getByTestId("sharing-grants-empty").waitFor();
    assert.equal(await page.getByTestId("pin-dialog").count(), 0, "reading asks for no PIN");

    // 1. Import B's card: look first (no PIN) — the name and the grouped number — then add (PIN).
    await page.getByTestId("contact-import-text").fill(info.peerCard);
    await page.getByTestId("contact-inspect").click();
    await page.getByTestId("contact-inspection").waitFor();
    assert.equal(await page.getByTestId("pin-dialog").count(), 0, "looking at a card asks for no PIN");
    assert.equal(await page.getByTestId("contact-inspection-name").innerText(), "B");
    const shown = (await page.getByTestId("contact-inspection-id").innerText()).trim();
    assert.equal(shown, info.peerId.replace(/(.{4})(?=.)/g, "$1 "), "the identity number in groups of four");
    assert.ok(await page.getByTestId("contact-import").isDisabled(), "not before the number was checked");
    await page.getByTestId("contact-import-checked").click();
    await page.getByTestId("contact-import").click();
    // Adding is a change: the PIN, now.
    await page.getByTestId("pin-dialog").waitFor();
    await page.getByTestId("pin-dialog-input").fill(PIN);
    await page.getByTestId("pin-dialog-submit").click();
    await page.getByTestId("pin-dialog").waitFor({ state: "detached" });
    const row = page.getByTestId(`contact-${info.peerId.slice(0, 8)}`);
    await row.waitFor();
    await page.getByText("已加入：B").waitFor();

    // 2. B's AI calls the public agent: a card waits (B is not whitelisted).
    const first = await call();
    assert.equal(first.status, 200);
    const requests = page.getByTestId("sharing-requests");
    let card;
    for (let i = 0; i < 50; i++) {
      await page.getByTestId("sharing-requests-refresh").click();
      card = requests.locator('[data-testid^="request-"][data-testid$="-waiting"]');
      if (await card.count()) break;
      await page.waitForTimeout(200);
    }
    const waitingText = await card.first().innerText();
    assert.match(waitingText, /在等 1 次调用/);
    assert.match(waitingText, /来自 1 个 AI：agent:b-research/);
    const rid = (await card.first().getAttribute("data-testid")).replace(/-waiting$/, "");
    await page.getByTestId(`${rid}-caller`).getByText(/B · 互认的联系人/).waitFor();

    // 3. 仅本次 (the PIN still held: no dialog).
    await page.getByTestId(`${rid}-once`).click();
    await page.getByTestId("sharing-requests-empty").waitFor();
    assert.equal(await page.getByTestId("pin-dialog").count(), 0);
    // 仅本次 writes no grant.
    await page.getByTestId("sharing-grants-empty").waitFor();

    // 4. The next call asks again; 永久通过 → a standing grant.
    const second = await call();
    assert.equal(second.status, 200);
    let rid2;
    for (let i = 0; i < 50; i++) {
      await page.getByTestId("sharing-requests-refresh").click();
      const c = requests.locator('[data-testid^="request-"][data-testid$="-waiting"]');
      if (await c.count()) {
        rid2 = (await c.first().getAttribute("data-testid")).replace(/-waiting$/, "");
        break;
      }
      await page.waitForTimeout(200);
    }
    assert.ok(rid2 && rid2 !== rid, "a new card");
    await page.getByTestId(`${rid2}-always`).click();
    await page.getByTestId("sharing-requests-empty").waitFor();
    const grants = page.getByTestId("sharing-grants");
    await grants.getByText("B → 研究助手").waitFor();
    // The agent's line counts it.
    await page.getByTestId(`agent-${info.agentId}`).getByText(/1 条永久授权/).waitFor();

    // E2E_SHOTS=<dir>: keep a full-page picture of the phone layout.
    if (process.env.E2E_SHOTS)
      await page.screenshot({ path: require("node:path").join(process.env.E2E_SHOTS, "sharing-phone.png"), fullPage: true });
    // Phone width: nothing runs off the side.
    const wide = await page.evaluate(() => document.documentElement.scrollWidth);
    assert.ok(wide <= 392, `page wider than the phone: ${wide}`);
    assert.deepEqual(errors, []);
    console.log("e2e-sharing: ok");
  } finally {
    await browser?.close();
    server.kill("SIGTERM");
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
