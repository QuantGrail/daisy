/**
 * P6-27: a Chrome driven over the DevTools protocol directly — no
 * Playwright. Playwright's launch flags and its attach keep every page
 * "visible" and focused (no background tabs, no timer throttling, no
 * freezing); the phase-5 findings P5N-7 / P5N-8 are about exactly those
 * states. Here a page in a background tab is `hidden`, its timers are held
 * back, `Page.setWebLifecycleState` freezes it (`freeze` / `resume`), and
 * windows come and go like a person's (`Target.createTarget` newWindow).
 *
 *   const b = await launchChrome();           // its own profile directory
 *   const p = await b.newPage(url, { newWindow: true });
 *   await p.waitFor(`!!document.querySelector('[data-testid="x"]')`);
 *   await p.click("x");                        // a real mouse click
 *   await b.close();
 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const WebSocket = require("ws");
const { chromePath } = require("./e2e-open.cjs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Start Chrome (headless by default) with the profile in `dir` (a new one by default). */
async function launchChrome({ headless = true, dir, args = [] } = {}) {
  const own = !dir;
  dir = dir || fs.mkdtempSync(path.join(os.tmpdir(), "daisy-cdp-"));
  const chrome = spawn(
    chromePath(),
    [
      ...(headless ? ["--headless=new"] : []),
      "--remote-debugging-port=0",
      `--user-data-dir=${dir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--window-size=1280,900",
      ...args,
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  const exited = new Promise((r) => chrome.once("exit", r));
  const endpoint = await new Promise((ok, fail) => {
    let out = "";
    chrome.stderr.on("data", (d) => {
      out += d;
      const m = /DevTools listening on (ws:\S+)/.exec(out);
      if (m) ok(m[1]);
    });
    exited.then((code) => fail(Error(`Chrome exited (${code})`)));
  });
  const ws = new WebSocket(endpoint, { perMessageDeflate: false });
  await new Promise((ok, fail) => {
    ws.once("open", ok);
    ws.once("error", fail);
  });
  let next = 0;
  const pending = new Map();
  ws.on("message", (data) => {
    const m = JSON.parse(String(data));
    const p = m.id && pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.error) p.fail(Error(`${p.method}: ${m.error.message}`));
    else p.ok(m.result);
  });
  ws.on("close", () => {
    for (const p of pending.values()) p.fail(Error("DevTools connection closed"));
    pending.clear();
  });
  const send = (method, params = {}, sessionId) =>
    new Promise((ok, fail) => {
      const id = ++next;
      pending.set(id, { ok, fail, method });
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });

  const attach = async (targetId) => {
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    await send("Runtime.enable", {}, sessionId);
    await send("Page.enable", {}, sessionId);
    const page = {
      targetId,
      send: (method, params) => send(method, params, sessionId),
      /** The value of `expr` in the page (awaited), or an error after `ms`. */
      eval: async (expr, ms = 8000) => {
        const r = await Promise.race([
          send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, sessionId),
          sleep(ms).then(() => {
            throw Error(`evaluate timed out: ${expr.slice(0, 80)}`);
          }),
        ]);
        if (r.exceptionDetails)
          throw Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
        return r.result.value;
      },
      /** Wait until `expr` is truthy in the page; its value. */
      waitFor: async (expr, ms = 15000) => {
        const end = Date.now() + ms;
        let last;
        for (;;) {
          try {
            const v = await page.eval(expr, 2000);
            if (v) return v;
          } catch (e) {
            last = e;
          }
          if (Date.now() > end) throw Error(`not in time: ${expr}${last ? ` (${last.message})` : ""}`);
          await sleep(50);
        }
      },
      goto: (url) => send("Page.navigate", { url }, sessionId),
      reload: () => send("Page.reload", {}, sessionId),
      /** A real mouse click in the middle of the element with this test id. */
      click: async (testId) => {
        const at = await page.waitFor(
          `(() => { const e = document.querySelector('[data-testid="${testId}"]'); if (!e) return null; const r = e.getBoundingClientRect(); return r.width ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null; })()`,
        );
        for (const type of ["mousePressed", "mouseReleased"])
          await send("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, button: "left", clickCount: 1 }, sessionId);
      },
      /** Bring this tab to the front (the others become hidden). */
      activate: () => send("Target.activateTarget", { targetId }),
      close: () => send("Target.closeTarget", { targetId }),
    };
    return page;
  };
  const browser = {
    dir,
    send,
    /** A new tab (`{ newWindow: true }`: a new window) at `url`. */
    newPage: async (url = "about:blank", o = {}) =>
      attach((await send("Target.createTarget", { url, ...o })).targetId),
    /** Close every page (the windows), leaving the browser running. */
    closeAllPages: async () => {
      const { targetInfos } = await send("Target.getTargets");
      for (const t of targetInfos.filter((t) => t.type === "page"))
        await send("Target.closeTarget", { targetId: t.targetId }).catch(() => {});
    },
    close: async () => {
      send("Browser.close").catch(() => {});
      await Promise.race([exited, sleep(5000)]);
      chrome.kill("SIGKILL");
      await exited;
      ws.terminate();
      if (own) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    },
  };
  return browser;
}

module.exports = { launchChrome, sleep };
