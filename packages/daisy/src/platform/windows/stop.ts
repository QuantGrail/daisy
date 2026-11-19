/**
 * P5-05 (ADR-141): `daisy stop` on Windows. There is no SIGTERM to send a
 * process without a console (Node's process.kill there is TerminateProcess:
 * no draining, turns cut without being marked). So the command line writes
 * <data>\run\stop-request with the Daisy's pid, and the Daisy process —
 * looking every half second, Windows only — removes it and shuts down
 * exactly as on SIGTERM (turns end 中断, not replayed; HTTP drains; exit 0,
 * so the supervisor does not start it again).
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const stopRequestFile = (dataDir: string) => join(dataDir, "run", "stop-request");

/** Ask the Daisy with `pid` to stop. */
export function requestStop(dataDir: string, pid: number) {
  mkdirSync(join(dataDir, "run"), { recursive: true, mode: 0o700 });
  writeFileSync(stopRequestFile(dataDir), `${pid}\n`, { mode: 0o600 });
}

/**
 * Call `onStop` once a stop request for this process (its pid, or none
 * named) appears. A request naming another pid (an older Daisy's, left
 * behind) is removed and ignored. Returns the stop of the watch.
 */
export function watchStopRequest(dataDir: string, onStop: () => void, pid = process.pid, everyMs = 500): () => void {
  const file = stopRequestFile(dataDir);
  // One left from before this process: not for it.
  rmSync(file, { force: true });
  const t = setInterval(() => {
    let text: string;
    try {
      text = readFileSync(file, "utf8").trim();
    } catch {
      return;
    }
    rmSync(file, { force: true });
    if (text && text !== String(pid)) return;
    clearInterval(t);
    onStop();
  }, everyMs);
  (t as any).unref?.();
  return () => clearInterval(t);
}
