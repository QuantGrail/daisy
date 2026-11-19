import { t } from "./i18n";
/**
 * Composer height (2026-10-29; drag reworked 2026-11-10):
 * the message box is one line when empty, grows upward with its text, and a
 * drag bar on its top edge lets the user pull it taller to see more at once.
 * The pulled height is a floor kept per browser (localStorage); typing past
 * it keeps growing up to AUTO_MAX or the floor, whichever is larger, then
 * scrolls. Pulling the bar back down to one line drops the floor (automatic
 * height again); a press that does not move the bar never changes it. The
 * cap keeps the conversation visible above the box.
 */
/** One line: lineHeight 26 + 5 px padding above and below. */
export const COMPOSER_MIN = 36;
export const COMPOSER_AUTO_MAX = 240;
/** Arrow keys on the drag bar. */
export const COMPOSER_STEP = 24;
/**
 * A press that moves less than this is a click, not a drag. A finger or a
 * pen (and native touches, which name no pointer type) is less steady than
 * a mouse.
 */
export const composerSlop = (pointerType?: string) =>
  pointerType === "mouse" ? 3 : 8;
export const COMPOSER_KEY = "daisy.composer.height.v1";
/** The resize bar's accessible name (the current language). */
export const composerResizeLabel = () => t("ui-chat.composer.resizeLabel");
const CAP_RATIO = 0.55;
/** Left for the header, the trace bar, the action row and a few messages. */
const CAP_RESERVE = 400;
/** A short window (a phone with its keyboard up) still gets a few lines. */
const CAP_SHORT = 120;

export const composerCap = (windowHeight: number) =>
  Math.max(
    COMPOSER_MIN,
    Math.min(
      Math.round(windowHeight * CAP_RATIO),
      Math.max(Math.round(windowHeight) - CAP_RESERVE, CAP_SHORT),
    ),
  );

const clamp = (v: number, lo: number, hi: number) =>
  Math.min(Math.max(v, lo), hi);

/** Height for `content` px of text under a user floor (null = not pulled). */
export function composerHeight(
  content: number,
  floor: number | null,
  cap: number,
) {
  const f = clamp(floor ?? COMPOSER_MIN, COMPOSER_MIN, cap);
  return clamp(content, f, Math.min(cap, Math.max(COMPOSER_AUTO_MAX, f)));
}

/**
 * The floor to keep when the bar is put at `target` px, `prev` being the
 * floor until now. Down to one line: `null` (automatic height). Where the
 * box gets taller than `content` px of text alone: `target`. In between the
 * bar cannot be seen to go (the text holds the box up): a floor is never
 * made there, and one that exists is not raised or dropped — lowered to
 * `target` at most.
 */
export function composerFloor(
  target: number,
  content: number,
  cap: number,
  prev: number | null,
): number | null {
  if (!Number.isFinite(target)) return prev;
  const v = Math.round(Math.min(target, cap));
  if (v <= COMPOSER_MIN) return null;
  if (v > composerHeight(content, null, cap)) return v;
  return prev == null ? null : Math.min(prev, v);
}

/**
 * A drag of `dy` px from a box `start` px tall whose floor was `prev`. The
 * bar sits on top: up (dy < 0) is taller. Back where it began (dy = 0)
 * nothing changes.
 */
export function composerDrag(
  start: number,
  dy: number,
  content: number,
  cap: number,
  prev: number | null,
) {
  const floor = dy === 0 ? prev : composerFloor(start - dy, content, cap, prev);
  return { floor, height: composerHeight(content, floor, cap) };
}

/** The floor saved in this browser; older, taller values are still good. */
export function storedComposerFloor(
  raw: string | null | undefined,
): number | null {
  if (raw == null || raw.trim() === "") return null;
  const v = Number(raw);
  return Number.isFinite(v) && v > COMPOSER_MIN ? Math.round(v) : null;
}

/** Keys on the drag bar: ↑ / ↓ one step, Home (as a double click) = reset. */
export function composerKeyAction(
  key: string,
): "grow" | "shrink" | "reset" | null {
  if (key === "ArrowUp") return "grow";
  if (key === "ArrowDown") return "shrink";
  if (key === "Home") return "reset";
  return null;
}
