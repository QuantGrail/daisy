// Identity browser check: the /identity panel switches a Claude Code
// conversation to another identity and saves the identity's model slots.
// Run: node scripts/e2e-identity.cjs (after npm run build:web).
const { chromium } = require("playwright");
const { chromePath, openLink, e2eEnv } = require("./e2e-open.cjs");
const { spawn } = require("node:child_process");
const assert = require("node:assert/strict");
(async () => {
  const server = spawn(
    process.execPath,
    ["--import", "tsx", "scripts/fixture-server.ts"],
    {
      stdio: ["ignore", "inherit", "inherit", "ipc"], env: e2eEnv(),
    },
  );
  let browser;
  try {
    const info = await new Promise((res, rej) => {
      server.once("message", res);
      server.once("exit", () => rej(Error("fixture stopped")));
    });
    browser = await chromium.launch({
      executablePath: chromePath(),
      headless: true,
      args: ["--no-sandbox"],
    });
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    // P1-08: no password — the link `daisy open` prints (one-time code).
    await page.goto(openLink(info));
    await page.getByTestId("new-session").waitFor();
    const token = await page.evaluate(
      () => JSON.parse(sessionStorage.getItem("daisy.auth.v1")).token,
    );
    const api = (path, method = "GET", body) =>
      fetch(info.url + "/api" + path, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      }).then(async (r) => ({
        status: r.status,
        json: await r.json().catch(() => null),
      }));
    const cat = (await api("/catalog")).json;
    const nodeId = cat.nodes[0].id;
    const glm = await api("/profiles", "POST", {
      nodeId,
      agent: "claude",
      authMode: "apiKey",
      apiKey: "fake",
      label: "GLM max",
      baseUrl: "https://open.bigmodel.cn/api/anthropic",
      // A fable slot on GLM: the panel warns.
      modelSlots: { opus: "glm-5.3[1m]", fable: "claude-fable-5-1" },
    });
    assert.equal(glm.status, 200, JSON.stringify(glm.json));
    await page.reload();
    await page.getByTestId("new-session").click();
    await page
      .getByRole("button", { name: "Claude Code", exact: true })
      .click();
    await page.getByTestId("session-title").fill("Identity switch");
    await page.getByTestId("create-session").click();
    const composer = page.getByTestId("composer");
    await composer.fill("/identity");
    await page.getByTestId("slash-identity").click();
    await page
      .getByText(/当前身份/)
      .first()
      .waitFor();
    await page.getByText(/当前身份：/).waitFor();
    await page.screenshot({
      path: "artifacts/identity-panel.png",
      fullPage: true,
    });
    await page.getByTestId(`identity-switch-${glm.json.id}`).click();
    await page.getByText(/已换成「GLM max」/).waitFor();
    await page.getByText("当前身份：GLM max").waitFor();
    // Slots of the now-current identity are shown: the fable slot on GLM
    // is warned about; 「填入 GLM 预设」 fills cc-switch's mapping (no fable)
    // and the warning goes; 「填入官方预设」 fills Opus 5.5 everywhere.
    await page.getByTestId("glm-model-warning").waitFor();
    await page.getByTestId("slots-preset-official").click();
    assert.equal(
      await page.getByLabel("fable", { exact: true }).inputValue(),
      "claude-opus-5-5[1m]",
    );
    await page.getByTestId("slots-preset-glm").click();
    await page.getByTestId("glm-model-warning").waitFor({ state: "detached" });
    assert.equal(
      await page.getByLabel("sonnet", { exact: true }).inputValue(),
      "glm-5.3-flash[1m]",
    );
    await page
      .getByRole("button", { name: "保存模型槽位", exact: true })
      .click();
    await page.getByText(/已保存这个身份的模型槽位/).waitFor();
    await page.screenshot({
      path: "artifacts/identity-switched.png",
      fullPage: true,
    });
    await page.getByRole("button", { name: "关闭", exact: true }).click();
    await page
      .getByText(/身份已从「.*」切换到「GLM max」/)
      .first()
      .waitFor();
    const sessions = (await api("/sessions")).json;
    const s = (Array.isArray(sessions) ? sessions : sessions.sessions).find(
      (x) => x.title === "Identity switch",
    );
    assert.equal(s.profileId, glm.json.id);
    const prof = (await api("/catalog")).json.profiles.find(
      (p) => p.id === glm.json.id,
    );
    assert.deepEqual(prof.modelSlots, {
      opus: "glm-5.3[1m]",
      sonnet: "glm-5.3-flash[1m]",
      haiku: "glm-5.3-flash[1m]",
    });
    assert.deepEqual(errors, []);
    console.log("identity panel browser passed");
  } finally {
    await browser?.close();
    server.kill("SIGTERM");
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
