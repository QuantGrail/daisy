/**
 * P5-01 (ADR-143 §6): structured logs — one JSON object per line. Only the
 * fields named in FIELDS ever reach a line, whatever a caller passes: no
 * payload bytes, no claim, nonce or proof, no SNI of names this relay does
 * not serve. A field outside the list is dropped (and counted, so a test
 * catches the attempt).
 */

export type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** The only keys a log line may carry besides `ts`, `lvl`, `ev`. */
export const FIELDS = new Set([
  "ip", // the peer's address
  "sub", // a Daisy's subdomain (identity prefix; plan: identity numbers go in logs)
  "n", // a stream's serial number
  "code", // a close code / alert number
  "reason", // a short fixed reason word chosen by the relay
  "inBytes",
  "outBytes",
  "ms",
  "count",
  "port",
  "host", // where the relay listens
  "domain", // the relay's own domain
  "version",
]);

export type Fields = Record<string, string | number | boolean | undefined>;

export interface Logger {
  debug(ev: string, f?: Fields): void;
  info(ev: string, f?: Fields): void;
  warn(ev: string, f?: Fields): void;
  error(ev: string, f?: Fields): void;
  /** Fields dropped because they are not in FIELDS (tests assert 0). */
  readonly dropped: number;
}

export function makeLogger(
  level: Level,
  write: (line: string) => void = (l) => process.stdout.write(l + "\n"),
): Logger {
  let dropped = 0;
  const emit = (lvl: Level, ev: string, f?: Fields) => {
    if (ORDER[lvl] < ORDER[level]) return;
    const o: Record<string, unknown> = { ts: new Date().toISOString(), lvl, ev };
    if (f)
      for (const [k, v] of Object.entries(f)) {
        if (v === undefined) continue;
        if (!FIELDS.has(k)) {
          dropped++;
          continue;
        }
        // Strings are short and fixed by the relay; cap anyway.
        o[k] = typeof v === "string" ? v.slice(0, 120) : v;
      }
    write(JSON.stringify(o));
  };
  return {
    debug: (ev, f) => emit("debug", ev, f),
    info: (ev, f) => emit("info", ev, f),
    warn: (ev, f) => emit("warn", ev, f),
    error: (ev, f) => emit("error", ev, f),
    get dropped() {
      return dropped;
    },
  };
}
