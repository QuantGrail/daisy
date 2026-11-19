/**
 * P2-03: `daisy watch` — follow the event outlet (docs/contracts/events.md)
 * the way a subscriber should: a snapshot first (unless told where to
 * start), then `GET /api/events?after=…&wait=…` again and again. One event
 * per line on standard output (CloudEvents JSON), status on standard error.
 *
 * A local command (LOCAL_COMMANDS), not one of the table's: it makes many
 * calls and keeps running. It calls the two routes by their ids
 * (`events.snapshot`, `events.list`) like any client.
 *
 * Resuming (events.md §4): `--cursor-file` keeps the cursor, written after
 * a page has been printed — after a crash the same page may come again
 * (de-duplicate by `id`), none is lost. A `cursor_reset` answer (the cursor
 * is older than what was kept, or Daisy's data was rebuilt) takes a new
 * snapshot and reads on from it. Daisy restarting or gone for a while: it
 * waits and retries from the same cursor.
 */
import { EVENT_LIMITS, EVENTS_RESET_CODE } from "../../../../contracts/src/index.ts";
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { CliError, usageError } from "../errors.ts";
import { Daisy, type Ctx } from "../daisy.ts";
import { callRoute } from "../routes.ts";
import type { LocalArgs } from "./options.ts";
import { t } from "../lang.ts";

const LIST = "events.list";
const SNAPSHOT = "events.snapshot";

const int = (v: string | true | undefined, name: string, min: number, max: number) => {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (v === true || !Number.isInteger(n) || n < min || n > max)
    throw usageError(t("cli.watch.intRange", { name, min, max }), t("cli.watch.intRangeFix", { name }));
  return n;
};

function readCursor(file: string): number | undefined {
  let text: string;
  try {
    text = readFileSync(file, "utf8").trim();
  } catch (e: any) {
    if (e?.code === "ENOENT") return undefined;
    throw new CliError(
      t("cli.watch.cursorUnreadable", { file, code: e?.code ?? t("cli.watch.cursorReadFailed") }),
      t("cli.watch.cursorUnreadableFix"),
    );
  }
  const n = Number(text);
  if (!Number.isInteger(n) || n < 0)
    throw new CliError(t("cli.watch.cursorBad", { file, text: text.slice(0, 40) }), t("cli.watch.cursorBadFix"));
  return n;
}
function saveCursor(file: string, n: number) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${n}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

export async function watchEvents(ctx: Ctx, a: LocalArgs): Promise<number> {
  const io = ctx.io;
  const file = typeof a.flags["--cursor-file"] === "string" ? a.flags["--cursor-file"] : undefined;
  const given = int(a.flags["--after"], "--after", 0, Number.MAX_SAFE_INTEGER);
  const wait = int(a.flags["--wait"], "--wait", 1, EVENT_LIMITS.waitMaxS) ?? EVENT_LIMITS.waitMaxS;
  const max = int(a.flags["--max"], "--max", 1, Number.MAX_SAFE_INTEGER);
  let cursor = given ?? (file ? readCursor(file) : undefined);
  let printed = 0;
  let backoff = 1000;
  let down = false;
  const seen = new Set<string>();
  /**
   * One event per line; a repeat within this run (a snapshot after a
   * reset) is not printed twice. When `--max` is reached: the `seq` of the
   * last event printed; otherwise null.
   */
  const print = (events: any[]): number | null => {
    for (const ev of events) {
      if (typeof ev?.id === "string") {
        if (seen.has(ev.id)) continue;
        seen.add(ev.id);
        if (seen.size > 10_000) seen.delete(seen.values().next().value!);
      }
      io.out(JSON.stringify(ev));
      printed++;
      if (max !== undefined && printed >= max) return Number(ev.seq);
    }
    return null;
  };
  const keep = (n: number) => {
    cursor = n;
    if (file) saveCursor(file, n);
  };
  for (;;) {
    try {
      const d = Daisy.connect(ctx);
      if (cursor === undefined) {
        const s = (await callRoute(d, SNAPSHOT)).data;
        io.err(t("cli.watch.snapshot", { n: s.events.length, cursor: s.cursor }));
        // Stopped inside the snapshot (--max): no cursor is kept, the next
        // run takes the snapshot again rather than skip the cards not shown.
        if (print(s.events) !== null) return 0;
        keep(s.cursor);
      }
      if (down) io.err(t("cli.watch.reconnected", { cursor: String(cursor) }));
      down = false;
      backoff = 1000;
      const p = (
        await callRoute(d, LIST, {
          query: { after: cursor, wait },
          timeoutMs: (wait + 30) * 1000,
        })
      ).data;
      // Saved once a page is handled (events.md §4). Stopping inside a page (--max)
      // keeps the last printed event's sequence.
      const stop = print(p.events);
      if (stop !== null) {
        keep(stop);
        return 0;
      }
      keep(p.cursor);
    } catch (e) {
      if (e instanceof CliError && e.code === EVENTS_RESET_CODE) {
        io.err(t("cli.watch.reset", { cursor: String(cursor) }));
        cursor = undefined;
        continue;
      }
      if (e instanceof CliError && (e.code === "not_running" || e.exitCode === 3)) {
        if (!down)
          io.err(cursor === undefined ? t("cli.watch.downSnapshot", { why: e.message }) : t("cli.watch.down", { why: e.message, cursor }));
        down = true;
        await io.sleep(backoff);
        backoff = Math.min(backoff * 2, 30_000);
        continue;
      }
      throw e;
    }
  }
}

/** Help: `cli.local.watch.usage` / `.help` (its `{max}` is the longest wait). */
export const WATCH_HELP_PARAMS = { max: EVENT_LIMITS.waitMaxS };
