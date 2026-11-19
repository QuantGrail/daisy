/**
 * P5-03 (ADR-142, W-3's browser stand-in): pairing a phone.
 *
 * The owner, on this machine's page (desktop), opens 设置 › 设备 and makes a
 * pairing code (PIN): the code, its QR and its link are shown. A phone
 * (390 px, its own browser context) opens the link on the outside face:
 * the login screen is in its pairing mode with the code filled in; one tap
 * pairs it and it sees the conversations. It survives a reload (its device
 * credential is kept). The owner sees it in the list and revokes it (PIN);
 * the phone's next request — its live connection is cut at once — sends it
 * back to the login screen, told why, its credential forgotten.
 *
 * P6-26 (phase-5 re-acceptance P5N-5, P5N-6), a desktop browser paired too:
 * a new window of the same browser (no session yet) is let in on its first
 * load — also when the address it opens still carries the used `#pair=`
 * link (a browser completing it from history); the owner revokes it with
 * the command line's route while it sits on a conversation, and — with no
 * reload, no click — it is on the login screen within seconds, told why,
 * nothing of the conversation left; a new `#pair=` link arriving on that
 * open login screen opens the pairing mode with the code filled in.
 *
 * P6-27 (2nd re-acceptance P5N-8, P5N-7), a desktop Chrome driven over the
 * DevTools protocol directly (scripts/e2e-cdp.cjs — Playwright keeps every
 * page visible and unthrottled): its window is sent to the background (the
 * page hidden, timers held back) and then frozen (Page Lifecycle `freeze`)
 * — once with its live socket still up, once with the socket gone and every
 * reconnect failing (a long back-off); it is revoked while frozen; when it
 * is resumed and shown it is on the login screen within 2 s, told why.
 * Closing every window and opening a new one at the root lets it in; a
 * Daisy that does not answer the first load (its requests held) ends in the
 * login screen with a message within the boot limit, never a blank page.
 *
 *   npm run build:web && node scripts/e2e-pairing.cjs
 *
 * All real: the fixture backend (scripts/fixture-server.ts with
 * FIXTURE_EXTERNAL=127.0.0.1, plain HTTP: loopback is allowed) has the PIN
 * 246810 and the outside face on. No model is involved.
 */
const { chromium } = require("playwright");
const { spawn } = require("node:child_process");
const assert = require("node:assert/strict");
const { chromePath, openLink, e2eEnv } = require("./e2e-open.cjs");
const { launchChrome, sleep } = require("./e2e-cdp.cjs");

const PIN = "246810";

(async () => {
  const server = spawn(process.execPath, ["--import", "tsx", "scripts/fixture-server.ts"], {
    stdio: ["ignore", "inherit", "inherit", "ipc"],
    env: { ...e2eEnv(), FIXTURE_EXTERNAL: "127.0.0.1", FIXTURE_EXTERNAL_TLS: "0" },
  });
  let browser;
  try {
    const info = await new Promise((resolve, reject) => {
      server.once("message", resolve);
      server.once("exit", () => reject(Error("Fixture backend stopped")));
    });
    assert.ok(info.externalUrl, "outside face");
    browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    const errors = [];
    // 1. The owner: this machine's page, 设置 › 设备, a pairing code (PIN).
    const owner = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    owner.on("pageerror", (e) => errors.push(`owner: ${e.message}`));
    await owner.goto(openLink(info));
    await owner.getByText("⚙ 设置", { exact: true }).click();
    await owner.getByTestId("settings-devices").waitFor();
    await owner.getByTestId("devices-empty").waitFor();
    await owner.getByTestId("devices-pair-name").fill("测试手机");
    await owner.getByTestId("devices-pair").click();
    await owner.getByTestId("pin-dialog").waitFor();
    await owner.getByTestId("pin-dialog-input").fill(PIN);
    await owner.getByTestId("pin-dialog-submit").click();
    await owner.getByTestId("devices-pair-code").waitFor();
    const code = (await owner.getByTestId("devices-pair-code-text").innerText()).trim();
    assert.match(code, /^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
    await owner.getByTestId("devices-pair-qr").waitFor();
    const link = (await owner.getByText(/#pair=/).innerText()).trim();
    assert.equal(link, `${info.externalUrl}/#pair=${encodeURIComponent(code)}`);

    // 2. The phone: its own browser, the link on the outside face.
    const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const phone = await phoneCtx.newPage();
    phone.on("pageerror", (e) => errors.push(`phone: ${e.message}`));
    await phone.goto(link);
    await phone.getByTestId("login-pair-code").waitFor();
    assert.equal(await phone.getByTestId("login-pair-code").inputValue(), code, "the code from the link is filled in");
    assert.ok(!phone.url().includes("#pair="), "the code left the address bar");
    await phone.getByTestId("login-submit").click();
    await phone.getByTestId("mobile-nav-open").waitFor(); // the phone layout: in
    const me = await phone.evaluate(async () => {
      const a = JSON.parse(sessionStorage.getItem("daisy.auth.v1") || "{}");
      const r = await fetch("/api/me", { headers: { authorization: `Bearer ${a.token}` } });
      return r.json();
    });
    assert.equal(me.channel, "device");
    assert.equal(me.face, "external");
    // A reload keeps it in (the device credential is kept on the phone).
    await phone.evaluate(() => sessionStorage.clear());
    await phone.reload();
    await phone.getByTestId("mobile-nav-open").waitFor(); // the phone layout: in

    // P6-26: a desktop browser (its own profile), paired with a code from the API.
    const api = async (method, path, body) => {
      const r = await fetch(info.url + "/api" + path, {
        method,
        headers: { authorization: `Bearer ${info.token}`, ...(body ? { "content-type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { status: r.status, json: await r.json().catch(() => null) };
    };
    const grant = async () => (await api("POST", "/pin/grant", { pin: PIN })).json.grant;
    const apiPin = async (method, path, body) => {
      const r = await fetch(info.url + "/api" + path, {
        method,
        headers: { authorization: `Bearer ${info.token}`, "daisy-pin-grant": await grant(), ...(body ? { "content-type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { status: r.status, json: await r.json().catch(() => null) };
    };
    const cat = (await api("GET", "/catalog")).json;
    const conv = (
      await api("POST", "/sessions", {
        agent: "claude",
        title: "P5 卡片",
        workspaceId: cat.workspaces[0].id,
        profileId: cat.profiles.find((p) => p.agent === "claude").id,
      })
    ).json;
    assert.ok(conv.id, "a conversation to sit on");
    const d1Link = (await apiPin("POST", "/devices/pair", { name: "D1" })).json.url;
    const d1 = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    let w = await d1.newPage();
    w.on("pageerror", (e) => errors.push(`d1: ${e.message}`));
    await w.goto(d1Link);
    await w.getByTestId("login-pair-code").waitFor();
    await w.getByTestId("login-submit").click();
    await w.getByTestId("new-session").waitFor();
    const inOrLogin = (page) =>
      Promise.race([
        page.getByTestId("new-session").waitFor({ timeout: 15000 }).then(() => "in"),
        page.getByTestId("login-submit").waitFor({ timeout: 15000 }).then(() => "login"),
      ]);
    // P5N-5: the window closed, a new one opened at the root: in on the first load.
    await w.close();
    w = await d1.newPage();
    w.on("pageerror", (e) => errors.push(`d1: ${e.message}`));
    await w.goto(info.externalUrl + "/");
    assert.equal(await inOrLogin(w), "in", "a new window of a paired browser is let in on its first load");
    // ... and when the address still carries the used pairing link.
    await w.close();
    w = await d1.newPage();
    w.on("pageerror", (e) => errors.push(`d1: ${e.message}`));
    await w.goto(d1Link);
    assert.equal(await inOrLogin(w), "in", "a paired browser opening the used `#pair=` link is let in");
    assert.ok(!w.url().includes("#pair="), "the code left the address bar");
    // P5N-6: on the conversation, revoked by the command line's route; no reload, no click.
    await w.getByText("P5 卡片").first().click();
    await w.getByTestId("composer-box").waitFor();
    const d1Id = (await api("GET", "/devices?state=active")).json.devices.find((x) => x.name === "D1").id;
    const t0 = Date.now();
    const rv = await apiPin("DELETE", `/devices/${d1Id}`);
    assert.equal(rv.status, 200);
    assert.equal(rv.json.revoked.state, "revoked");
    await w.getByText(/配对已失效/).waitFor({ timeout: 5000 });
    console.log(`e2e-pairing: revoked D1 on its login screen after ${Date.now() - t0} ms`);
    await w.getByTestId("login-submit").waitFor();
    assert.equal(await w.getByTestId("composer-box").count(), 0, "nothing of the conversation is left");
    assert.equal(await w.evaluate(() => localStorage.getItem("daisy.device.v1")), null, "the credential is forgotten");
    assert.equal(await w.evaluate(() => sessionStorage.getItem("daisy.auth.v1")), null, "the session is forgotten");
    // A new pairing link arriving on the open login screen (only the hash changes).
    const fresh = (await apiPin("POST", "/devices/pair", { name: "D1 again" })).json;
    await w.evaluate((h) => (window.location.hash = h), "#pair=" + encodeURIComponent(fresh.code));
    await w.getByTestId("login-pair-code").waitFor();
    assert.equal(await w.getByTestId("login-pair-code").inputValue(), fresh.code, "the new code is filled in");
    assert.ok(!w.url().includes("#pair="), "and left the address bar");
    await d1.close();

    // P6-27: a desktop Chrome of its own (DevTools protocol, no Playwright).
    const chrome = await launchChrome();
    try {
      const IN = `!!document.querySelector('[data-testid="new-session"]')`;
      const GONE = `document.body.innerText.includes("配对已失效")`;
      const STATE = `(() => document.querySelector('[data-testid="new-session"]') ? "in" : document.querySelector('[data-testid="login-submit"]') ? "login" : "other:" + document.body.innerText.slice(0, 60))()`;
      const pairD3 = async (name) => {
        const link = (await apiPin("POST", "/devices/pair", { name })).json.url;
        const p = await chrome.newPage(link);
        // Paired already (a working pairing wins over the link — P6-26): in directly.
        if ((await p.waitFor(`(() => { const s = ${STATE}; return s.startsWith("other:") ? "" : s; })()`)) === "login") await p.click("login-submit");
        await p.waitFor(IN);
        return p;
      };
      const deviceId = async (name) =>
        (await api("GET", "/devices?state=active")).json.devices.find((x) => x.name === name).id;
      // P5N-7: every window closed, a new window at the root: in, on its first load and after a reload.
      await pairD3("D3");
      await chrome.closeAllPages();
      await sleep(500);
      let p = await chrome.newPage(info.externalUrl + "/", { newWindow: true });
      assert.equal(await p.waitFor(`(() => { const s = ${STATE}; return s.startsWith("other:") ? "" : s; })()`), "in", "a new window after every window closed is let in");
      await p.reload();
      await sleep(300);
      await p.waitFor(IN);
      // P5N-7: Daisy does not answer the paired device's first load (its API requests held):
      // bounded — the workspace (an outage: it keeps trying), never a blank page.
      await p.send("Fetch.enable", { patterns: [{ urlPattern: "*/api/me*" }, { urlPattern: "*/api/devices/session*" }] });
      let t7 = Date.now();
      await p.reload();
      await sleep(300);
      await p.waitFor(IN, 10000);
      assert.equal(await p.eval(`document.documentElement.dataset.daisyBoot`), "done");
      console.log(`e2e-pairing: an unanswered first load of a paired device shows the workspace after ${Date.now() - t7} ms`);
      await p.send("Fetch.disable");
      await p.close();
      // P5N-8: revoked while its window is in the background and the page frozen.
      for (const [name, way] of [["D3", "socket up"], ["D3 again", "socket gone, reconnects failing"]]) {
        // D3 is still paired from above; after its revocation this profile pairs anew.
        const w = await pairD3(name);
        await w.waitFor(`(() => { const e = [...document.querySelectorAll("div")].find((d) => d.textContent === "P5 卡片"); e?.click(); return !!document.querySelector('[data-testid="composer-box"]'); })()`);
        if (way !== "socket up") {
          // The socket dies and every reconnect fails: the page sits in its back-off.
          await w.send("Network.enable");
          await w.send("Network.setBlockedURLs", { urls: ["*/api/live*"] });
          await w.send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
          await sleep(500);
          await w.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
          await sleep(2000);
        }
        const other = await chrome.newPage("about:blank");
        await other.activate();
        await w.waitFor(`document.visibilityState === "hidden"`);
        await w.send("Page.setWebLifecycleState", { state: "frozen" });
        await sleep(500);
        assert.equal((await apiPin("DELETE", `/devices/${await deviceId(name)}`)).status, 200);
        await sleep(1500);
        const shown = Date.now();
        await w.send("Page.setWebLifecycleState", { state: "active" });
        await w.activate();
        await w.waitFor(GONE, 2000);
        console.log(`e2e-pairing: revoked while frozen (${way}): on its login screen ${Date.now() - shown} ms after it was shown`);
        assert.equal(await w.eval(`document.querySelectorAll('[data-testid="composer-box"]').length`), 0, "nothing of the conversation is left");
        await w.send("Network.setBlockedURLs", { urls: [] }).catch(() => {});
        await other.close();
        await w.close();
      }
      // P5N-7: an unpaired page whose first load Daisy does not answer: the login screen
      // with a message within the boot limit (8 s), never a blank page.
      const u = await chrome.newPage("about:blank");
      await u.send("Fetch.enable", { patterns: [{ urlPattern: "*/api/web/session*" }] });
      const t8 = Date.now();
      await u.goto(info.externalUrl + "/");
      await u.waitFor(`document.body.innerText.includes("迟迟没有回应")`, 12000);
      assert.equal(await u.eval(STATE), "login");
      assert.equal(await u.eval(`document.documentElement.dataset.daisyBoot`), "late");
      console.log(`e2e-pairing: an unanswered first load ends on the login screen, told why, after ${Date.now() - t8} ms`);
      await u.close();
    } finally {
      await chrome.close();
    }

    // 3. The owner sees it, and revokes it (PIN).
    await owner.getByTestId("devices-show-all").click();
    const row = owner.locator('[data-testid^="device-dev_"]').filter({ hasText: "测试手机" }).first();
    await row.waitFor();
    assert.match(await row.innerText(), /测试手机/);
    const id = (await row.getAttribute("data-testid")).slice("device-".length);
    await owner.getByTestId(`device-revoke-${id}`).click();
    // The PIN grant from step 1 is still good for a few minutes (or asked again).
    if (await owner.getByTestId("pin-dialog").isVisible().catch(() => false)) {
      await owner.getByTestId("pin-dialog-input").fill(PIN);
      await owner.getByTestId("pin-dialog-submit").click();
    }
    await owner.getByText("已吊销").first().waitFor();

    // 4. The phone is out: back to the login screen, told why, credential gone.
    await phone.reload();
    await phone.getByText(/配对已失效/).waitFor({ timeout: 15000 });
    const kept = await phone.evaluate(() => localStorage.getItem("daisy.device.v1"));
    assert.equal(kept, null, "the device credential is forgotten");
    assert.deepEqual(errors, []);
    console.log("e2e-pairing: ok");
  } finally {
    await browser?.close();
    server.kill("SIGTERM");
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
