/**
 * Browser test of DaisyChat's host page context (fb3) in the shape
 * a host embeds it: scripts/context-harness.tsx bundled with esbuild, served
 * by the isolated fixture backend, driven with Playwright.
 *
 * Covers: first message carries the context, same key is not re-sent (F2),
 * a new key is re-sent and the bar flashes 「已切换到」, × skips one message,
 * over-long contexts are cut to fit instead of failing with 400, the message
 * tag stays inside the column, the context panel collapses after send / page
 * change, compact chrome shows the activity as one summary line, and the
 * composer keeps its height while a turn runs.
 */
const { chromium } = require("playwright");
const { chromePath, e2eEnv } = require("./e2e-open.cjs");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
// esbuild ships with tsx (already a dependency).
const esbuild = require("esbuild");

const root = path.resolve(__dirname, "..");
const nm = path.join(root, "node_modules");

async function bundle(dir) {
  await esbuild.build({
    entryPoints: [path.join(root, "scripts/context-harness.tsx")],
    bundle: true,
    outfile: path.join(dir, "harness.js"),
    alias: {
      "react-native": "react-native-web",
      react: path.join(nm, "react"),
      "react-dom": path.join(nm, "react-dom"),
      "@daisy-ai/client": path.join(root, "packages/client/src/index.ts"),
      "@daisy-ai/contracts": path.join(root, "packages/contracts/src/index.ts"),
    },
    resolveExtensions: [".web.tsx", ".web.ts", ".web.js", ".tsx", ".ts", ".js"],
    define: {
      "process.env.NODE_ENV": '"production"',
      __DEV__: "false",
      global: "globalThis",
    },
    loader: { ".js": "jsx" },
    jsx: "automatic",
    logLevel: "warning",
  });
  fs.writeFileSync(
    path.join(dir, "index.html"),
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>html,body,#root{height:100%;margin:0}</style></head><body><div id="root"></div><script src="harness.js"></script></body></html>',
  );
}

(async () => {
  const web = fs.mkdtempSync(path.join(os.tmpdir(), "daisy-context-web-"));
  await bundle(web);
  const server = spawn(
    process.execPath,
    ["--import", "tsx", "scripts/fixture-server.ts"],
    {
      cwd: root,
      stdio: ["ignore", "inherit", "inherit", "ipc"],
      env: { ...e2eEnv(), DAISY_E2E_WEB_DIR: web },
    },
  );
  let browser;
  try {
    // P1-08: the fixture hands over a web session of the owner (no password).
    const { url, token } = await new Promise((resolve, reject) => {
      server.once("message", resolve);
      server.once("exit", () => reject(Error("Fixture backend stopped")));
    });
    const api = async (p, method = "GET", body, token) => {
      const r = await fetch(url + "/api" + p, {
        method,
        headers: {
          ...(body ? { "content-type": "application/json" } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (!r.ok) throw Error(`${method} ${p}: ${r.status} ${await r.text()}`);
      return r.json();
    };
    const catalog = await api("/catalog", "GET", undefined, token);
    const session = await api(
      "/sessions",
      "POST",
      {
        title: "上下文验收",
        agent: "codex",
        workspaceId: catalog.workspaces[0].id,
        profileId: catalog.profiles.find((p) => p.agent === "codex").id,
      },
      token,
    );
    const users = async () =>
      (
        await api(`/sessions/${session.id}`, "GET", undefined, token)
      ).items.filter((i) => i.kind === "user");
    const status = async () =>
      (await api(`/sessions/${session.id}`, "GET", undefined, token)).session
        .status;

    browser = await chromium.launch({
      executablePath: chromePath(),
      headless: true,
      args: ["--no-sandbox"],
    });
    const page = await browser.newPage({
      viewport: { width: 1100, height: 900 },
    });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    await page.goto(
      `${url}/#token=${token}&sid=${session.id}&chrome=compact&width=420&autofocus=1`,
    );
    // E2E_SHOTS=<dir> keeps screenshots of the key states for review.
    const shot = async (name) =>
      process.env.E2E_SHOTS &&
      page.screenshot({
        path: path.join(process.env.E2E_SHOTS, `context-${name}.png`),
      });
    const bar = page.getByTestId("context-bar");
    const label = page.getByTestId("context-bar-label");
    await bar.waitFor();
    assert.equal(
      await label.innerText(),
      "附带上下文：任务 T-1 · 修复导出口径",
    );
    // autoFocus: the composer has focus once usable.
    await page.waitForFunction(
      () => document.activeElement?.getAttribute("data-testid") === "composer",
    );
    // Mounting is not a page switch (review r2 N4).
    assert.equal(await page.getByTestId("context-bar-switched").count(), 0);
    // compact idle: the trace bar — still dots, the idle line,
    // model · online · / 命令.
    const statusLine = page.getByTestId("chat-status-line");
    assert.match(await statusLine.innerText(), /\/ 命令/);
    assert.match(await statusLine.innerText(), /离线/);
    assert.equal(await page.getByTestId("chat-working").count(), 0);

    const send = async (text) => {
      await page.getByTestId("composer").fill(text);
      await page.getByTestId("send-message").click();
      await page.waitForFunction(
        () => !document.querySelector('[data-testid="composer"]').value,
      );
      // Sent, not 「等待发送」 (review r2 N7), right after the request.
      for (let i = 0; i < 4; i++) {
        assert.equal(
          await page.getByText("等待发送", { exact: true }).count(),
          0,
        );
        await page.waitForTimeout(100);
      }
    };
    let cardChecked = false;
    const finishTurn = async () => {
      for (let i = 0; i < 150; i++) {
        const card = page.getByTestId("approval-card");
        if (await card.count()) {
          if (!cardChecked) {
            // A shell command reads as one line; raw JSON is folded away.
            assert.equal(
              await card.getByTestId("approval-command").innerText(),
              "要运行命令：pwd",
            );
            assert.equal(await card.getByText('"command"').count(), 0);
            await card.getByTestId("approval-input-toggle").click();
            await card
              .getByText(/"command"/)
              .first()
              .waitFor();
            // D-39: the chat card answers a permission
            // prompt itself (this host harness has no 「审批」 page, so no
            // secondary link to it).
            assert.ok(
              (await card
                .getByRole("button", { name: /允许|Allow|accept|批准/ })
                .count()) > 0,
            );
            assert.equal(
              await card.getByTestId("approval-open-inbox").count(),
              0,
            );
            cardChecked = true;
          }
          // Answer it the way the 「审批」 page does (POST /approvals/:id/respond).
          const { items } = await api(
            "/approvals?status=pending",
            "GET",
            undefined,
            token,
          );
          for (const x of items.filter(
            (x) => x.kind === "permission" && x.session?.id === session.id,
          )) {
            const allow = x.options.find((o) =>
              /允许|Allow|accept|批准/.test(o.label),
            );
            await api(
              `/approvals/${encodeURIComponent(x.id)}/respond`,
              "POST",
              { decision: allow.key },
              token,
            ).catch((e) => {
              // 409 = answered by an earlier pass already; anything else fails the test.
              if (!/: 409 /.test(e.message)) throw e;
            });
          }
        }
        if ((await status()) === "idle") return;
        await page.waitForTimeout(150);
      }
      throw Error("turn did not finish");
    };

    // Panel: no inner scroll, first lines + 「展开全部」; collapses on send.
    await bar.getByText("查看", { exact: true }).click();
    const panel = page.getByTestId("context-panel");
    await panel.waitFor();
    const clamped = (await panel.boundingBox()).height;
    assert.ok(clamped <= 170, `compact panel stays short (${clamped})`);
    assert.equal(
      await panel.evaluate((el) =>
        [...el.querySelectorAll("*")].some((n) =>
          /auto|scroll/.test(getComputedStyle(n).overflowY),
        ),
      ),
      false,
      "no inner scroll",
    );
    await panel.getByTestId("context-text-all").click();
    assert.ok((await panel.boundingBox()).height > clamped + 100);
    await panel.getByTestId("context-text-all").click();

    // 1. First message carries the context.
    await send("这个任务卡在哪里？");
    assert.equal(await panel.count(), 0, "panel collapses after send");
    await finishTurn();
    let u = await users();
    assert.equal(u[0].context.key, "tasks/T-1");
    await bar.getByText("已附带", { exact: true }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.sent), ["tasks/T-1"]);

    // Compact activity: one summary line that names the command and merges
    // the authorization (no separate 「已批准」 row); never 「节点」.
    const summary = page.getByTestId("activity-summary").first();
    await summary.waitFor();
    assert.match(await summary.innerText(), /运行了 pwd（允许本次）/);
    assert.equal(await page.getByTestId("approval-record").count(), 0);
    assert.equal(await page.getByTestId("activity-scroll").count(), 0);
    await summary.click();
    await page.getByTestId("activity-scroll").first().waitFor();
    assert.equal(await page.getByText("回到第一步").count(), 0);
    // Expanded: every dot reached once the turn is over (N / N 已完成).
    await page.waitForTimeout(1400);
    const faded = await page
      .getByTestId("activity-dot")
      .evaluateAll(
        (dots) =>
          dots.filter(
            (d) => Number(getComputedStyle(d.parentElement).opacity) < 0.9,
          ).length,
      );
    assert.equal(faded, 0, "no faded dots after the turn");
    assert.equal(await page.getByText(/本轮用量 · /).count(), 0);
    await summary.click();
    assert.equal(await page.getByText(/个节点/).count(), 0);

    // 2. Same key: not re-sent.
    await send("再问一句");
    await finishTurn();
    u = await users();
    assert.equal(u[1].context, undefined, "same key is not sent again");

    // 3. New key: the bar flashes 「已切换到」, then the next message carries it.
    await bar.getByText("查看", { exact: true }).click();
    await panel.waitFor();
    await page.evaluate(() => window.setContext("B"));
    await page.getByTestId("context-bar-switched").waitFor();
    assert.equal(await label.innerText(), "已切换到：时间线 · 修复导出口径");
    await shot("switched");
    assert.equal(await panel.count(), 0, "panel collapses on page change");
    await page.waitForTimeout(2900);
    assert.equal(await page.getByTestId("context-bar-switched").count(), 0);
    assert.equal(await label.innerText(), "附带上下文：时间线 · 修复导出口径");

    // 4. × skips exactly one message.
    await page.getByTestId("context-dismiss").click();
    assert.equal(
      await label.innerText(),
      "下一条不附带上下文：时间线 · 修复导出口径",
    );
    await send("这条不带上下文");
    await finishTurn();
    u = await users();
    assert.equal(u[2].context, undefined, "× skipped this message");
    assert.equal(await label.innerText(), "附带上下文：时间线 · 修复导出口径");
    await send("这条带上时间线");
    await finishTurn();
    u = await users();
    assert.equal(u[3].context.key, "tasks/T-1/timeline");

    // null → key is not a switch either.
    await page.evaluate(() => window.setContext(null));
    await page.evaluate(() => window.setContext("A"));
    await page.waitForTimeout(200);
    assert.equal(await page.getByTestId("context-bar-switched").count(), 0);

    // 5. Over-long context: cut to fit, never a 400.
    await page.evaluate(() => window.setContext("LONG"));
    await page.getByTestId("context-bar-switched").waitFor();
    assert.equal(await bar.getByText("已附带").count(), 0);
    await send("长页面也能发");
    // Once sent: only 「已附带」, never together with 「已切换到」.
    await bar.getByText("已附带", { exact: true }).waitFor();
    assert.equal(await page.getByTestId("context-bar-switched").count(), 0);
    assert.doesNotMatch(await label.innerText(), /已切换到/);
    await finishTurn();
    u = await users();
    const long = u[4].context;
    assert.ok(long, "long context still attached");
    assert.ok(long.key.length <= 300 && long.key.includes("#"));
    assert.equal(long.label.length, 200);
    assert.equal(long.url, undefined);
    assert.equal(await page.getByText(/400|Bad Request|Too big/i).count(), 0);

    await shot("long-tags");
    // 6. Message tags stay inside the chat column (no overflow to the left).
    const column = await page.getByTestId("chat-column").boundingBox();
    for (const tag of await page.getByTestId("message-context").all()) {
      const box = await tag.boundingBox();
      assert.ok(
        box.x >= column.x - 1,
        `tag starts inside the column (${box.x})`,
      );
      assert.ok(box.x + box.width <= column.x + column.width + 1);
      assert.ok(box.height <= 24, `collapsed tag is one line (${box.height})`);
    }

    // 7. Composer height is stable while a turn runs (compact).
    await page.evaluate(() => window.setContext(null));
    assert.equal(await bar.count(), 0);
    const composerBox = () =>
      page.getByTestId("composer").locator("xpath=../..").boundingBox();
    const idle = await composerBox();
    await shot("idle");
    await send("WAIT_UNTIL_CANCEL");
    for (let i = 0; i < 100 && (await status()) !== "running"; i++)
      await page.waitForTimeout(100);
    await page.getByText("■ 停止").waitFor();
    await page.getByTestId("composer").fill("排队一条");
    await page.getByTestId("steer-message").waitFor();
    const running = await composerBox();
    await shot("running");
    assert.ok(
      Math.abs(running.height - idle.height) <= 2,
      `composer height ${idle.height} → ${running.height}`,
    );
    assert.equal(await page.getByText("8 MiB / 文件").count(), 0);
    // compact running: the badge, and the trace bar above the composer with
    // its moving dots and the current step (host page feedback
    // 2026-10-11: a running turn must always show signs of life).
    const runningLine = await statusLine.innerText();
    assert.match(runningLine, /执行中/);
    assert.equal(await page.getByTestId("chat-working").count(), 1);
    assert.ok((await page.getByTestId("trace-detail").innerText()).trim());
    await page.getByText("■ 停止").click();
    for (let i = 0; i < 100 && (await status()) !== "interrupted"; i++)
      await page.waitForTimeout(100);

    assert.ok(cardChecked, "the authorization card was checked");
    assert.deepEqual(errors, []);
    console.log(
      "Context browser test passed: attach once, re-attach on change with highlight, × skips one, over-long fitted, tags contained, compact summary, stable composer.",
    );
  } finally {
    await browser?.close();
    server.kill("SIGTERM");
    fs.rmSync(web, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
