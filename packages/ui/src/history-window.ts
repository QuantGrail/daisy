/**
 * Reading upward in a long AI conversation, kept free of React so
 * it is unit-tested (tests/session-freshness.test.ts). DaisyChat shows the
 * newest turns of the items it holds; reading within a screen of the top
 * shows more of them, and once all held turns are shown, pages older items
 * in from the server — the 「加载更早的对话」 button does the same by hand.
 */

/** Turns shown per step upward. */
export const EARLIER_STEP = 40;

/** Within one screen of the top of the transcript. */
export function nearTop(offset: number, viewport: number) {
  return offset < Math.max(viewport, 200);
}

/**
 * The next step upward: `show` held turns that are not rendered yet, `fetch`
 * an older page first (the window was cut from a longer conversation), or
 * nothing (the start of the conversation is shown).
 */
export function earlierStep(
  hiddenTurns: number,
  partial: boolean,
): "show" | "fetch" | null {
  if (hiddenTurns > 0) return "show";
  return partial ? "fetch" : null;
}

/**
 * After this step, read the next page ahead (in the background) when fewer
 * than a step of held turns would remain hidden.
 */
export function readAhead(hiddenTurns: number, partial: boolean) {
  return partial && hiddenTurns - EARLIER_STEP < EARLIER_STEP;
}

/**
 * Content was added above what is being read: the scroll offset that keeps
 * the same distance from the bottom (what the reader sees stays put).
 */
export function keepPosition(contentHeight: number, fromBottom: number) {
  return Math.max(0, contentHeight - fromBottom);
}
