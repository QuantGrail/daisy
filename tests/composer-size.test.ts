import { test } from "node:test";
import assert from "node:assert/strict";
import {
  COMPOSER_AUTO_MAX,
  COMPOSER_MIN,
  COMPOSER_STEP,
  composerCap,
  composerDrag,
  composerFloor,
  composerHeight,
  composerKeyAction,
  composerSlop,
  storedComposerFloor,
} from "../packages/ui/src/composer-height.ts";

// The message box grows upward with its text and can be
// pulled taller; the conversation above always keeps some room.
test("composer grows with text, keeps a pulled floor, stays under the cap", () => {
  const cap = composerCap(1000);
  assert.equal(cap, 550);
  // Unpulled: one line stays at the minimum, long text grows to AUTO_MAX.
  assert.equal(composerHeight(20, null, cap), COMPOSER_MIN);
  assert.equal(composerHeight(150, null, cap), 150);
  assert.equal(composerHeight(5000, null, cap), COMPOSER_AUTO_MAX);
  // Pulled to 400: short text keeps 400, long text grows to 400 then scrolls.
  assert.equal(composerHeight(20, 400, cap), 400);
  assert.equal(composerHeight(5000, 400, cap), 400);
  // Pulled past the cap (window got smaller): clamped.
  assert.equal(composerHeight(20, 900, cap), cap);
});

// 2026-11-10: an empty box is one line (26 px line + 5 px padding each way).
test("the minimum is one line", () => {
  assert.equal(COMPOSER_MIN, 36);
  assert.equal(composerHeight(36, null, 550), 36);
  // Two lines of text: 2 × 26 + 10.
  assert.equal(composerHeight(62, null, 550), 62);
});

test("the cap leaves room for the conversation", () => {
  // Tall window: 55%.
  assert.equal(composerCap(1000), 550);
  assert.equal(composerCap(1400), 770);
  // Shorter: at least 400 px stay for the header, bars and messages.
  assert.equal(composerCap(800), 400);
  assert.equal(composerCap(700), 300);
  // A short window (phone, keyboard up) still gets a few lines …
  assert.equal(composerCap(450), 120);
  // … and a tiny one never goes below one line.
  assert.equal(composerCap(40), COMPOSER_MIN);
  for (const h of [0, 40, 200, 450, 700, 1000, 2000]) {
    assert.ok(composerCap(h) >= COMPOSER_MIN, `cap(${h}) ≥ min`);
    if (h >= 2 * COMPOSER_MIN)
      assert.ok(composerCap(h) <= h * 0.55 + 1, `cap(${h}) ≤ 55%`);
  }
});

test("a new floor needs to show; only one line drops an existing floor", () => {
  const cap = 550;
  // Empty box, no floor yet: anything above one line is a floor.
  assert.equal(composerFloor(300, COMPOSER_MIN, cap, null), 300);
  assert.equal(composerFloor(37, COMPOSER_MIN, cap, null), 37);
  // At or under the minimum: automatic height again, floor or not.
  assert.equal(composerFloor(COMPOSER_MIN, COMPOSER_MIN, cap, null), null);
  assert.equal(composerFloor(COMPOSER_MIN, COMPOSER_MIN, cap, 300), null);
  assert.equal(composerFloor(-200, COMPOSER_MIN, cap, 300), null);
  assert.equal(composerFloor(20, 218, cap, 200), null);
  // Not a number: nothing changes.
  assert.equal(composerFloor(NaN, COMPOSER_MIN, cap, null), null);
  assert.equal(composerFloor(NaN, COMPOSER_MIN, cap, 300), 300);
  // Five lines of text (140 px) and no floor: under the text the bar cannot
  // be seen to move, so no floor is made there.
  assert.equal(composerFloor(100, 140, cap, null), null);
  assert.equal(composerFloor(140, 140, cap, null), null);
  assert.equal(composerFloor(141, 140, cap, null), 141);
  // A floor of 200 under text that grew to 218: it is kept (review of
  // 6d1c9a3 — it used to be dropped, and the box fell to one line after
  // sending) …
  assert.equal(composerFloor(214, 218, cap, 200), 200);
  assert.equal(composerFloor(218, 218, cap, 200), 200);
  // … lowered when the bar is put under it, never raised unseen …
  assert.equal(composerFloor(194, 218, cap, 200), 194);
  assert.equal(composerFloor(60, 218, cap, 200), 60);
  // … and replaced once the bar shows above the text.
  assert.equal(composerFloor(260, 218, cap, 200), 260);
  // Text past AUTO_MAX scrolls at AUTO_MAX: a new floor starts above that.
  assert.equal(composerFloor(COMPOSER_AUTO_MAX, 5000, cap, null), null);
  assert.equal(composerFloor(300, 5000, cap, null), 300);
  // Never above the cap; fractions are rounded.
  assert.equal(composerFloor(9000, COMPOSER_MIN, cap, null), cap);
  assert.equal(composerFloor(200.6, COMPOSER_MIN, cap, null), 201);
  assert.equal(composerFloor(36.4, COMPOSER_MIN, cap, 300), null);
});

test("a drag follows the pointer; dragged back to one line it clears the floor", () => {
  const cap = 550;
  // Up (dy < 0) is taller.
  assert.deepEqual(composerDrag(COMPOSER_MIN, -100, COMPOSER_MIN, cap, null), {
    floor: 136,
    height: 136,
  });
  assert.deepEqual(composerDrag(136, -64, COMPOSER_MIN, cap, 136), {
    floor: 200,
    height: 200,
  });
  // Past the cap: stops there.
  assert.deepEqual(composerDrag(136, -5000, COMPOSER_MIN, cap, 136), {
    floor: cap,
    height: cap,
  });
  // Back down to (or past) one line: no floor, automatic height.
  assert.deepEqual(composerDrag(300, 264, COMPOSER_MIN, cap, 300), {
    floor: null,
    height: COMPOSER_MIN,
  });
  assert.deepEqual(composerDrag(300, 900, COMPOSER_MIN, cap, 300), {
    floor: null,
    height: COMPOSER_MIN,
  });
  // With three lines typed (88 px) the box stops at its text; the floor is
  // where the bar was put (50), or gone at one line.
  assert.deepEqual(composerDrag(300, 250, 88, cap, 300), {
    floor: 50,
    height: 88,
  });
  assert.deepEqual(composerDrag(300, 270, 88, cap, 300), {
    floor: null,
    height: 88,
  });
  // Three lines and no floor: pulling down makes none.
  assert.deepEqual(composerDrag(88, 30, 88, cap, null), {
    floor: null,
    height: 88,
  });
});

test("no movement changes nothing — also when the text is taller than the floor", () => {
  const cap = 550;
  // Pulled, text shorter than the floor.
  assert.deepEqual(composerDrag(300, 0, COMPOSER_MIN, cap, 300), {
    floor: 300,
    height: 300,
  });
  // Not pulled.
  assert.deepEqual(composerDrag(88, 0, 88, cap, null), {
    floor: null,
    height: 88,
  });
  // Floor 200, text grew to 218 (the box shows 218): a tap, a drag that
  // comes back, 4 px down, one ↓ — the floor stays a floor.
  assert.deepEqual(composerDrag(218, 0, 218, cap, 200), {
    floor: 200,
    height: 218,
  });
  assert.deepEqual(composerDrag(218, 4, 218, cap, 200), {
    floor: 200,
    height: 218,
  });
  assert.deepEqual(composerDrag(218, COMPOSER_STEP, 218, cap, 200), {
    floor: 194,
    height: 218,
  });
  // A floor saved above today's cap (older value, smaller window) is not
  // rewritten by a tap either.
  assert.deepEqual(composerDrag(cap, 0, COMPOSER_MIN, cap, 700), {
    floor: 700,
    height: cap,
  });
});

test("a click is not a drag: 3 px for a mouse, 8 px for a finger or pen", () => {
  assert.equal(composerSlop("mouse"), 3);
  assert.equal(composerSlop("touch"), 8);
  assert.equal(composerSlop("pen"), 8);
  // Native touches name no pointer type.
  assert.equal(composerSlop(), 8);
});

test("arrow keys step, one step down from just above the minimum resets", () => {
  const cap = 550;
  const up = composerDrag(
    COMPOSER_MIN,
    -COMPOSER_STEP,
    COMPOSER_MIN,
    cap,
    null,
  );
  assert.deepEqual(up, { floor: 60, height: 60 });
  const down = composerDrag(
    up.height,
    COMPOSER_STEP,
    COMPOSER_MIN,
    cap,
    up.floor,
  );
  assert.deepEqual(down, { floor: null, height: COMPOSER_MIN });
  assert.equal(composerKeyAction("ArrowUp"), "grow");
  assert.equal(composerKeyAction("ArrowDown"), "shrink");
  // Home and a double click on the bar are the same reset: floor `null`.
  assert.equal(composerKeyAction("Home"), "reset");
  assert.equal(composerHeight(88, null, cap), 88);
  assert.equal(composerKeyAction("Enter"), null);
  assert.equal(composerKeyAction("a"), null);
});

test("the saved floor: older, taller values are still read", () => {
  assert.equal(storedComposerFloor(null), null);
  assert.equal(storedComposerFloor(undefined), null);
  assert.equal(storedComposerFloor(""), null);
  assert.equal(storedComposerFloor("abc"), null);
  assert.equal(storedComposerFloor("Infinity"), null);
  // Saved under the old 54 px minimum: above today's 36, so kept.
  assert.equal(storedComposerFloor("55"), 55);
  assert.equal(storedComposerFloor("700"), 700);
  // … and brought under today's cap when used.
  assert.equal(composerHeight(36, storedComposerFloor("700"), 550), 550);
  // Not above one line: no floor.
  assert.equal(storedComposerFloor("36"), null);
  assert.equal(storedComposerFloor("20"), null);
  assert.equal(storedComposerFloor("-5"), null);
});
