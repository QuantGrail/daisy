// Browser check for the composer additions:
// 「在终端执行」 toggle (dark-red composer, run, result chip, sent with the next
// message), the context ring, and edit-and-resend of a sent message.
const { chromium } = require("playwright");
const { chromePath, openLink, e2eEnv } = require("./e2e-open.cjs");
const { spawn } = require("node:child_process");
const assert = require("node:assert/strict");
(async () => {
  const server = spawn(
    process.execPath,
    ["--import", "tsx", "scripts/fixture-server.ts"],
    { stdio: ["ignore", "inherit", "inherit", "ipc"], env: e2eEnv() },
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
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => {
      if (m.type() === "error" && /Content Security Policy/.test(m.text()))
        errors.push(m.text());
    });
    // Counts React commits through the DevTools hook React reports to (1b).
    await page.addInitScript(() => {
      window.__commits = 0;
      window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
        isDisabled: false,
        supportsFiber: true,
        renderers: new Map(),
        inject: () => 1,
        onCommitFiberRoot: () => void window.__commits++,
        onPostCommitFiberRoot() {},
        onCommitFiberUnmount() {},
        checkDCE() {},
      };
    });
    // P1-08: no password — the link `daisy open` prints (one-time code).
    await page.goto(openLink(info));
    await page.getByTestId("new-session").click();
    await page
      .getByRole("button", { name: "Claude Code", exact: true })
      .click();
    await page.getByTestId("session-title").fill("Composer");
    await page.getByTestId("create-session").click();
    const composer = page.getByTestId("composer");
    // E2E_SHOTS=<dir>: screenshots for a visual check.
    const shot = async (name) => {
      if (process.env.E2E_SHOTS)
        await page.screenshot({ path: `${process.env.E2E_SHOTS}/${name}.png` });
    };
    const box = page.getByTestId("composer-box");
    const finishTurn = async () => {
      // The 「审批」 page path (D-39: the chat card answers it too).
      await page.getByTestId("approval-open-inbox").click();
      await page
        .getByTestId("approvals-panel")
        .getByRole("button", { name: "允许本次", exact: true })
        .click();
      await page.getByRole("button", { name: "关闭 ✕", exact: true }).click();
      await page.getByTestId("chat-working").waitFor({ state: "hidden" });
    };
    // 1. Context ring appears once the Agent reports usage.
    await composer.fill("first message");
    await page.getByTestId("send-message").click();
    await finishTurn();
    const ring = page.getByTestId("context-ring");
    await ring.waitFor();
    // used / the Agent's real trigger point (fixture: 50000 of a
    // 200000 window, auto-compact at 167000 → 30%).
    assert.match(await ring.innerText(), /30%/);
    assert.ok(
      await ring.locator("svg circle").count(),
      "web draws an SVG ring",
    );
    // 1b. Composer height (2026-11-10): one line when empty; the drag bar
    // follows the pointer without a React render, saves on release, a double
    // click or Home goes back to automatic height.
    const bar = page.getByTestId("composer-resize");
    const KEY = "daisy.composer.height.v1";
    const px = (loc) =>
      loc.evaluate((e) => Math.round(e.getBoundingClientRect().height));
    const stored = () => page.evaluate((k) => localStorage.getItem(k), KEY);
    const storedIs = (v) =>
      page.waitForFunction(([k, w]) => localStorage.getItem(k) === w, [KEY, v]);
    const frame = () =>
      page.evaluate(
        () =>
          new Promise((r) =>
            requestAnimationFrame(() => requestAnimationFrame(r)),
          ),
      );
    const commits = () => page.evaluate(() => window.__commits);
    const resizing = () =>
      page.evaluate(() => ({
        on: document.documentElement.classList.contains("daisy-resizing"),
        cursor: getComputedStyle(document.body).cursor,
        select: getComputedStyle(document.body).userSelect,
      }));
    assert.equal(await composer.inputValue(), "");
    assert.equal(await stored(), null);
    const emptyBox = await px(box);
    assert.equal(await px(composer), 36, "an empty input is one line");
    // 138 px before this change (54 px input, 12 px padding, 8 px gaps).
    assert.ok(emptyBox <= 110, `empty composer box is ${emptyBox}px`);
    assert.equal(await bar.getAttribute("aria-valuemin"), "36");
    assert.equal(await bar.getAttribute("aria-valuenow"), "36");
    assert.equal(await bar.getAttribute("role"), "separator");
    assert.match(await bar.getAttribute("aria-label"), /调整输入框高度/);
    const hit = await bar.boundingBox();
    const boxRect = await box.boundingBox();
    assert.ok(hit.height >= 16, `drag bar hit area is ${hit.height}px high`);
    assert.ok(hit.width >= boxRect.width - 4, "drag bar spans the box");
    assert.ok(hit.y < boxRect.y, "it reaches over the box's top edge");
    const pill = () =>
      bar.evaluate((e) => {
        const c = getComputedStyle(e.firstElementChild);
        return `${c.width} ${c.backgroundColor}`;
      });
    const idlePill = await pill();
    assert.match(idlePill, /^36px /);
    const x = hit.x + hit.width / 2;
    const y = hit.y + hit.height / 2;
    await page.mouse.move(x, y);
    await page.waitForFunction(
      ([el, idle]) => {
        const c = getComputedStyle(el.firstElementChild);
        return c.width === "64px" && `${c.width} ${c.backgroundColor}` !== idle;
      },
      [await bar.elementHandle(), idlePill],
    );
    const sent = page.getByText("first message", { exact: true }).first();
    // The commit counter is connected: typing renders.
    const idle = await commits();
    await composer.fill("x");
    await composer.fill("");
    assert.ok((await commits()) > idle, "the commit counter sees a render");
    await composer.focus();
    // A press that does not move is a click: nothing is pinned.
    await page.mouse.down();
    assert.deepEqual(await resizing(), {
      on: true,
      cursor: "ns-resize",
      select: "none",
    });
    await page.mouse.up();
    assert.equal((await resizing()).on, false);
    assert.equal(await stored(), null);
    assert.equal(await px(composer), 36);
    // Drag up in 10 steps of 20 px.
    await page.mouse.down();
    const before = await commits();
    for (let i = 1; i <= 10; i++) {
      await page.mouse.move(x, y - i * 20);
      await frame();
      assert.equal(await px(composer), 36 + i * 20, `follows at step ${i}`);
    }
    const during = (await commits()) - before;
    // Before this change every move was a render of the whole page (≥ 10).
    assert.ok(during <= 1, `${during} React commits while dragging`);
    assert.equal(await bar.getAttribute("aria-valuenow"), "236");
    assert.equal(await stored(), null, "saved on release, not while dragging");
    assert.equal(
      await page.evaluate(() => window.getSelection().toString()),
      "",
      "dragging selects no text",
    );
    // A render in the middle of the drag (here: three lines typed, so React
    // itself writes a new height, 88 px) does not take the box back.
    const mid = await commits();
    await page.keyboard.insertText("one\ntwo\nthree");
    await page.waitForFunction((n) => window.__commits > n, mid);
    await frame();
    assert.equal(await composer.inputValue(), "one\ntwo\nthree");
    assert.equal(await px(composer), 236, "a render does not undo the drag");
    assert.equal((await resizing()).on, true);
    await page.mouse.move(x, y - 220);
    await frame();
    assert.equal(await px(composer), 256, "and the drag goes on");
    await page.mouse.move(x, y - 200);
    await page.mouse.up();
    await storedIs("236");
    assert.equal(await px(composer), 236);
    assert.equal(await px(box), emptyBox + 200);
    assert.equal(await bar.getAttribute("aria-valuenow"), "236");
    assert.equal((await resizing()).on, false);
    await shot("0-composer-pulled");
    // Typing under a floor keeps the floor.
    await composer.fill("");
    assert.equal(await px(composer), 236);
    // Double click: automatic height again, nothing saved.
    await bar.dblclick();
    await storedIs(null);
    assert.equal(await px(composer), 36);
    assert.equal(await px(box), emptyBox);
    // Dragged up, then back down past one line: no floor is left behind.
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, y - 150, { steps: 5 });
    await page.mouse.up();
    await storedIs("186");
    const top = (await bar.boundingBox()).y + hit.height / 2;
    await page.mouse.move(x, top);
    await page.mouse.down();
    await page.mouse.move(x, top + 400, { steps: 5 });
    await frame();
    assert.equal(await px(composer), 36);
    await page.mouse.up();
    await storedIs(null);
    assert.equal(await px(composer), 36);
    // With three lines typed the box stops at its text; let go there and the
    // next, empty box is one line again.
    await composer.fill("one\ntwo\nthree");
    assert.equal(await px(composer), 88, "three lines: 3 × 26 + 10");
    const top3 = (await bar.boundingBox()).y + hit.height / 2;
    await page.mouse.move(x, top3);
    await page.mouse.down();
    await page.mouse.move(x, top3 - 100, { steps: 4 });
    await page.mouse.move(x, top3 + 60, { steps: 4 });
    await page.mouse.up();
    await frame();
    assert.equal(await stored(), null);
    assert.equal(await px(composer), 88);
    await composer.fill("");
    assert.equal(await px(composer), 36);
    // Keys on the bar: ↑ / ↓ 24 px, Home resets.
    await bar.focus();
    await page.keyboard.press("ArrowUp");
    await storedIs("60");
    await page.keyboard.press("ArrowUp");
    await storedIs("84");
    assert.equal(await px(composer), 84);
    assert.equal(await bar.getAttribute("aria-valuenow"), "84");
    await page.keyboard.press("ArrowDown");
    await storedIs("60");
    await page.keyboard.press("ArrowDown");
    await storedIs(null);
    await page.keyboard.press("ArrowUp");
    await storedIs("60");
    await page.keyboard.press("Home");
    await storedIs(null);
    assert.equal(await px(composer), 36);
    // A floor under taller text is kept by a press, a drag that comes back
    // and a small pull down (review of 6d1c9a3: it was dropped).
    await page.keyboard.press("ArrowUp");
    await storedIs("60");
    await composer.fill("one\ntwo\nthree");
    assert.equal(await px(composer), 88);
    const top4 = (await bar.boundingBox()).y + hit.height / 2;
    await page.mouse.move(x, top4);
    await page.mouse.down();
    await page.mouse.up();
    await page.mouse.down();
    await page.mouse.move(x, top4 - 80, { steps: 3 });
    await page.mouse.move(x, top4, { steps: 3 });
    await page.mouse.up();
    await page.mouse.down();
    await page.mouse.move(x, top4 + 6, { steps: 2 });
    await page.mouse.up();
    await frame();
    assert.equal(await stored(), "60");
    assert.equal(await px(composer), 88);
    await composer.fill("");
    assert.equal(await px(composer), 60, "the floor is still there");
    // An interrupted drag puts the height back, keeps the saved floor and
    // never leaves the page in its resizing look.
    await page.evaluate(() =>
      window.addEventListener(
        "pointerdown",
        (e) => (window.__pid = e.pointerId),
        true,
      ),
    );
    const grab = async () => {
      const r = await bar.boundingBox();
      const gy = r.y + r.height / 2;
      await page.mouse.move(x, gy);
      await page.mouse.down();
      await page.mouse.move(x, gy - 100, { steps: 4 });
      await frame();
      assert.equal(await px(composer), 160);
      assert.equal((await resizing()).on, true);
      return gy;
    };
    const fire = (type, init = {}, onWindow = false) =>
      bar.evaluate(
        (el, [t, i, w]) =>
          w
            ? window.dispatchEvent(new Event(t))
            : el.dispatchEvent(
                new PointerEvent(t, {
                  bubbles: true,
                  pointerId: window.__pid,
                  ...i,
                }),
              ),
        [type, init, onWindow],
      );
    const putBack = async (how) => {
      assert.equal((await resizing()).on, false, `${how}: page look removed`);
      assert.equal(await px(composer), 60, `${how}: height put back`);
      assert.equal(await stored(), "60", `${how}: floor unchanged`);
      assert.equal(await bar.getAttribute("aria-valuenow"), "60");
      await page.mouse.up();
      await frame();
      assert.equal(await stored(), "60", `${how}: the late release is nothing`);
      assert.equal(await px(composer), 60);
    };
    await grab();
    await fire("pointercancel");
    await putBack("pointercancel");
    // Another pointer's events are not this drag's.
    await grab();
    const other = (await page.evaluate(() => window.__pid)) + 7;
    await fire("pointerup", { pointerId: other });
    await fire("pointercancel", { pointerId: other });
    assert.equal((await resizing()).on, true);
    assert.equal(await px(composer), 160);
    // The window loses focus mid-drag.
    await fire("blur", {}, true);
    await putBack("window blur");
    // A mouse seen moving with no button down: its release went elsewhere,
    // and it was a release — the height is kept.
    const gy = await grab();
    await fire("pointermove", {
      pointerType: "mouse",
      buttons: 0,
      clientX: x,
      clientY: gy - 300,
    });
    assert.equal((await resizing()).on, false);
    await storedIs("160");
    assert.equal(await px(composer), 160);
    await page.mouse.up();
    // The next press is not blocked.
    await bar.dblclick();
    await storedIs(null);
    assert.equal(await px(composer), 36);
    // The cap (55% of this 1000 px window) keeps the conversation in view.
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, y - 900, { steps: 6 });
    await page.mouse.up();
    await storedIs("550");
    assert.equal(await bar.getAttribute("aria-valuemax"), "550");
    assert.ok(await sent.isVisible());
    const sentBox = await sent.boundingBox();
    assert.ok(
      sentBox.y + sentBox.height <= (await box.boundingBox()).y,
      "a message is still shown above the tallest box",
    );
    await bar.dblclick();
    await storedIs(null);
    assert.equal(await px(box), emptyBox);
    // 2. Terminal mode: dark red, Enter runs, the switch stays on.
    const normalBg = await box.evaluate(
      (e) => getComputedStyle(e).backgroundColor,
    );
    await page.getByTestId("terminal-toggle").click();
    await page.getByTestId("terminal-warning").waitFor();
    const redBg = await box.evaluate(
      (e) => getComputedStyle(e).backgroundColor,
    );
    assert.notEqual(redBg, normalBg);
    assert.equal(redBg, "rgb(61, 11, 14)");
    assert.equal(await px(composer), 36, "terminal mode: same one line");
    await composer.fill("echo from-terminal; exit 2");
    await composer.press("Enter");
    await page.getByTestId("terminal-runs-note").waitFor();
    await page.getByText(/\$ echo from-terminal; exit 2 · ✗ 2/).waitFor();
    await composer.fill("pwd");
    await page.getByTestId("run-command").click();
    await page.getByText(/终端已执行完 2 条命令/).waitFor();
    assert.ok(
      await page.getByTestId("terminal-warning").isVisible(),
      "the switch stays on after running",
    );
    await page.getByText(/\$ echo from-terminal; exit 2 · ✗ 2/).click();
    await page.getByText("from-terminal", { exact: true }).waitFor();
    await shot("1-terminal-mode");
    // 3. Back to chat: the next message carries both runs.
    await page.getByTestId("terminal-toggle").click();
    await page.getByTestId("terminal-warning").waitFor({ state: "hidden" });
    await composer.fill("see the output above");
    await page.getByTestId("send-message").click();
    await finishTurn();
    await page.getByTestId("terminal-runs").waitFor({ state: "detached" });
    assert.equal(await page.getByTestId("message-terminal").count(), 1);
    await shot("2-sent-with-terminal");
    // 4. Edit and resend the second message (Codex: the fixture keeps no
    // Claude transcript to fork).
    await page.getByTestId("new-session").click();
    await page.getByRole("button", { name: "Codex", exact: true }).click();
    await page.getByTestId("session-title").fill("Edit");
    await page.getByTestId("create-session").click();
    // The new conversation has loaded: no usage yet (the ring stays
    // and says so), composer editable.
    await page
      .locator(
        '[data-testid="context-ring"][aria-label^="上下文用量不可用：尚无数据"]',
      )
      .waitFor();
    await page.waitForFunction(
      () =>
        document
          .querySelector('[data-testid="composer"]')
          ?.getAttribute("aria-disabled") !== "true",
    );
    await composer.fill("first");
    await page.getByTestId("send-message").click();
    await finishTurn();
    await composer.fill("see the output above");
    await page.getByTestId("send-message").click();
    await finishTurn();
    const edits = page.getByTestId("edit-message");
    assert.equal(await edits.count(), 2);
    await edits.nth(1).click();
    await page.getByTestId("editing-banner").waitFor();
    await shot("3-editing");
    assert.equal(await composer.inputValue(), "see the output above");
    await composer.fill("edited message");
    await page.getByRole("button", { name: "回退并重发", exact: true }).click();
    await page.getByText(/已回退 1 轮对话/).waitFor();
    await finishTurn();
    await page.getByText("edited message", { exact: true }).waitFor();
    assert.equal(await page.getByText("see the output above").count(), 0);
    assert.equal(await page.getByTestId("editing-banner").count(), 0);
    assert.deepEqual(errors, []);
    console.log(
      `Composer browser test passed: context ring, composer height (empty box ${emptyBox}px, drag without renders — counter checked against a render, a render mid-drag does not undo it, saved on release, interrupted drags put back, double click / Home reset), terminal mode (red, Enter runs, stays on, chips, sent with next message), edit and resend.`,
    );
  } catch (e) {
    if (page) await page.screenshot({ path: "/tmp/e2e-composer-fail.png" });
    console.error(e);
    process.exitCode = 1;
  } finally {
    await browser?.close();
    server.kill();
  }
})();
