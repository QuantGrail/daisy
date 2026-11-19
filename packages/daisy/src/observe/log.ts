/**
 * P1-11: the one way Daisy writes a log line (both halves: the control
 * plane and the in-process Runner). Every line is formatted, passed through
 * `redact` (S-1: no credential, token, PIN, grant or API key), tagged with
 * the current trace id when there is one (trace.md §6), written to standard
 * output / error (the service manager keeps them: journald, launchd), and
 * kept in a small ring the owner reads with `GET /api/logs` (5.11
 * 「查看日志和审计」).
 *
 * `installConsoleRedaction()` (main.ts) also routes the global console
 * through `redact`, for what libraries print; Daisy's own code calls `log`
 * (tests/log-redaction.test.ts: no `console.*` in packages/daisy/).
 */
import { formatWithOptions } from "node:util";
import { redact } from "./redact.ts";
import { currentTrace } from "./trace.ts";

export type LogLevel = "info" | "warn" | "error";
export interface LogLine {
  seq: number;
  at: number;
  level: LogLevel;
  text: string;
  trace?: string;
}

const RING = 1000;
const ring: LogLine[] = [];
let seq = 0;

/**
 * Where a line goes: the console as it was before installConsoleRedaction
 * patched it, else the console as it is now (late-bound: a test may stand
 * in for it).
 */
let original: Record<LogLevel, (...a: unknown[]) => void> | null = null;
const out = (level: LogLevel, text: string) => {
  if (original) return original[level](text);
  if (level === "info") console.log(text);
  else if (level === "warn") console.warn(text);
  else console.error(text);
};

function format(args: unknown[]): string {
  return formatWithOptions({ colors: false, depth: 4, breakLength: Infinity }, ...args);
}

function write(level: LogLevel, args: unknown[]) {
  let text: string;
  try {
    text = redact(format(args));
  } catch {
    text = "[log content could not be formatted]";
  }
  const trace = currentTrace()?.traceId;
  const line: LogLine = { seq: ++seq, at: Date.now(), level, text, ...(trace ? { trace } : {}) };
  ring.push(line);
  if (ring.length > RING) ring.shift();
  for (const s of sinks) {
    try {
      s(line);
    } catch {}
  }
  out(level, trace ? `${text} trace=${trace}` : text);
}

export const log = {
  info: (...args: unknown[]) => write("info", args),
  warn: (...args: unknown[]) => write("warn", args),
  error: (...args: unknown[]) => write("error", args),
};

/** The kept lines, newest last (GET /api/logs). */
export function recentLogs(o: {
  limit?: number;
  level?: LogLevel;
  trace?: string;
  after?: number;
} = {}): LogLine[] {
  const levels: LogLevel[] =
    o.level === "error" ? ["error"] : o.level === "warn" ? ["warn", "error"] : ["info", "warn", "error"];
  const out = ring.filter(
    (l) =>
      levels.includes(l.level) &&
      (!o.trace || l.trace === o.trace) &&
      (o.after === undefined || l.seq > o.after),
  );
  return out.slice(-Math.max(1, Math.min(o.limit ?? 200, RING)));
}

type Sink = (l: LogLine) => void;
const sinks = new Set<Sink>();
/** Tests: every line as it is written (already redacted). */
export function onLog(s: Sink): () => void {
  sinks.add(s);
  return () => sinks.delete(s);
}

let installed = false;
/**
 * The global console goes through `redact` too (a library's own output,
 * anything that slipped past `log`). Idempotent. Only the process entry
 * point calls it; tests keep the plain console.
 */
export function installConsoleRedaction(): void {
  if (installed) return;
  installed = true;
  original = {
    info: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };
  for (const [name, level] of [
    ["log", "info"],
    ["info", "info"],
    ["debug", "info"],
    ["warn", "warn"],
    ["error", "error"],
  ] as const)
    (console as any)[name] = (...args: unknown[]) => write(level, args);
}
