/**
 * P1-08 (P1-03's 「要留意的一点」, docs/WEB-ORIGINS.md): the page opened
 * through the outside face on a network address — plain HTTP (not a secure
 * context) and TLS with the self-signed certificate let through — reads
 * which browser features it has, then does one full turn with an approval
 * there, so what the page uses is proven to work without them.
 *
 *   npm run build:web && node scripts/e2e-web-origins.cjs [address]
 *
 * The address must be this machine's private-network address (default: the
 * first non-internal IPv4 one); 127.0.0.1 would be a secure context anyway.
 */
const { chromium } = require("playwright");
const { spawn } = require("node:child_process");
const os = require("node:os");
const assert = require("node:assert/strict");
const { chromePath, e2eEnv } = require("./e2e-open.cjs");

const address =
  process.argv[2] ||
  Object.values(os.networkInterfaces())
    .flat()
    .find(
      (i) =>
        i &&
        i.family === "IPv4" &&
        !i.internal &&
        /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(i.address),
    )?.address;

async function run(tls) {
  const server = spawn(
    process.execPath,
    ["--import", "tsx", "scripts/fixture-server.ts"],
    {
      stdio: ["ignore", "inherit", "inherit", "ipc"],
      env: {
        ...e2eEnv(),
        FIXTURE_EXTERNAL: address,
        FIXTURE_EXTERNAL_TLS: tls ? "1" : "0",
      },
    },
  );
  let browser;
  try {
    const info = await new Promise((resolve, reject) => {
      server.once("message", resolve);
      server.once("exit", () => reject(Error("Fixture backend stopped")));
    });
    assert.ok(info.externalUrl, "outside face");
    browser = await chromium.launch({
      executablePath: chromePath(),
      headless: true,
      args: ["--no-sandbox"],
    });
    // TLS: the self-signed certificate, let through as the owner would.
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      ignoreHTTPSErrors: tls,
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${info.externalUrl}/#code=${encodeURIComponent(info.externalCode)}`);
    await page.getByTestId("new-session").waitFor();
    const has = await page.evaluate(async () => {
      const ok = (f) => {
        try {
          return f();
        } catch {
          return false;
        }
      };
      let sw = "absent";
      if ("serviceWorker" in navigator)
        sw = await navigator.serviceWorker
          .register("/sw-probe.js")
          .then(() => "registered")
          .catch((e) => `refused (${String(e.message || e).slice(0, 60)})`);
      return {
        isSecureContext: window.isSecureContext,
        "navigator.clipboard": !!navigator.clipboard,
        "crypto.randomUUID": typeof crypto.randomUUID === "function",
        "crypto.subtle": !!crypto.subtle,
        "crypto.getRandomValues": typeof crypto.getRandomValues === "function",
        serviceWorker: sw,
        Notification: typeof Notification !== "undefined",
        BroadcastChannel: typeof BroadcastChannel !== "undefined",
        localStorage: ok(() => (localStorage.setItem("p", "1"), localStorage.getItem("p") === "1")),
        sessionStorage: ok(() => sessionStorage.getItem("daisy.auth.v1") !== null),
        WebSocket: typeof WebSocket !== "undefined",
        "execCommand('copy')": ok(() => document.queryCommandSupported("copy")),
      };
    });
    // One full turn with an approval card over this face: the page works
    // with what it has (makeId's fallback, the live socket, uploads).
    await page.getByTestId("new-session").click();
    await page.getByTestId("new-session-agent-codex").click();
    await page.getByTestId("session-title").fill(`对外面 · ${tls ? "TLS" : "明文"}`);
    await page.getByTestId("create-session").click();
    await page.getByTestId("composer").fill("请审阅任务并输出一张图。");
    await page.getByTestId("send-message").click();
    await page.getByTestId("approval-card").waitFor({ timeout: 30000 });
    await page.getByTestId("approval-open-inbox").click();
    await page
      .getByTestId("approvals-panel")
      .getByRole("button", { name: "允许本次", exact: true })
      .click();
    await page.getByRole("button", { name: "关闭 ✕", exact: true }).click();
    await page.getByText("审阅完成", { exact: true }).waitFor({ timeout: 30000 });
    // The live socket: a second turn's answer arrives without a reload.
    await page.getByTestId("composer").fill("再来一次");
    await page.getByTestId("send-message").click();
    await page.getByTestId("approval-card").waitFor({ timeout: 30000 });
    // Settings over the outside face (terminal / shell / browse are off there).
    await page.getByRole("button", { name: "⚙ 设置", exact: true }).click();
    await page.getByTestId("settings-access").waitFor();
    assert.deepEqual(errors, []);
    return has;
  } finally {
    await browser?.close();
    server.kill("SIGTERM");
    await new Promise((r) => server.once("exit", r));
  }
}

(async () => {
  assert.ok(address, "没有可用的内网地址；用参数指定一个本机的组网 / 内网地址");
  const plain = await run(false);
  const tls = await run(true);
  console.log(`outside face on ${address}:`);
  console.log(
    ["feature", "plain HTTP", "TLS (self-signed, let through)"].join(" | "),
  );
  for (const k of Object.keys(plain))
    console.log([k, String(plain[k]), String(tls[k])].join(" | "));
  assert.equal(plain.isSecureContext, false);
  assert.equal(tls.isSecureContext, true);
  console.log("Web origins test passed: a full turn with an approval works over both.");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
