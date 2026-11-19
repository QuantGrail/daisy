/**
 * P6-12 (ADR-157): external callback jobs. A plugin's event wakes a session
 * through the scheduler (`scheduler.wake(sid, scheduleId, …)`, hook 2); a
 * callback's scheduleId is `callback[-human]:<kind>:<item id>`, and the
 * job it queues has the request id `schedule:<scheduleId>:<job id>`.
 * `callback-human`: a person's decision (not held to a resident's daily
 * budget); `callback`: everything else.
 *
 * This frame is all the core knows: the kinds and the shape of an item id
 * are the plugin's. A plugin builds its scheduleId with
 * `callbackScheduleId` (exported by `@daisy-ai/daisy/plugin`), which
 * refuses a kind or item id the frame would not recognise — so a callback
 * is never silently treated as an ordinary timer wake.
 */
import { ownerT } from "../platform/language.ts";

/** A callback kind: lower-case letters, digits, `_` and `-`; at most 32. */
const KIND = "[a-z][a-z0-9_-]{0,31}";
/** An item id: letters, digits, `_`, `.` and `-`; at most 64; no `:`. */
const ITEM = "[A-Za-z0-9][A-Za-z0-9_.-]{0,63}";
const FRAME = new RegExp(
  `^schedule:((callback|callback-human):(${KIND}):(${ITEM})):`,
);
const IS_KIND = new RegExp(`^${KIND}$`),
  IS_ITEM = new RegExp(`^${ITEM}$`);

export interface CallbackJob {
  /** `callback[-human]:<kind>:<item id>` (kept callbacks are filed by it). */
  scheduleId: string;
  /** `callback-human`: a person's decision. */
  human: boolean;
  kind: string;
  itemId: string;
}

/** A callback wake job's parts from its request id (null: not one). */
export function callbackJob(requestId: unknown): CallbackJob | null {
  const m = FRAME.exec(String(requestId ?? ""));
  return m
    ? {
        scheduleId: m[1],
        human: m[2] === "callback-human",
        kind: m[3],
        itemId: m[4],
      }
    : null;
}

/**
 * The scheduleId a plugin wakes a session with for its callback of `kind`
 * about item `itemId` (`human`: a person decided). Throws when either part
 * does not fit the frame.
 */
export function callbackScheduleId(
  kind: string,
  itemId: string,
  o: { human?: boolean } = {},
): string {
  if (!IS_KIND.test(kind))
    throw Error(
      ownerT()("server-schedule.callback.badKind", { kind: String(kind).slice(0, 40) }),
    );
  if (!IS_ITEM.test(itemId))
    throw Error(
      ownerT()("server-schedule.callback.badItem", { item: String(itemId).slice(0, 70) }),
    );
  return `${o.human ? "callback-human" : "callback"}:${kind}:${itemId}`;
}
