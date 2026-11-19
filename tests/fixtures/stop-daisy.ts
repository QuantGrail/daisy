// P5-05: stop a Daisy process the way `daisy stop` does on each system —
// SIGTERM on Linux / macOS; on Windows (no SIGTERM for a process without a
// console) the stop request it watches for.
import type { ChildProcess } from "node:child_process";
import { requestStop } from "../../packages/daisy/src/platform/windows/stop.ts";

export function stopGracefully(child: ChildProcess, dataDir: string) {
  if (process.platform === "win32") requestStop(dataDir, child.pid!);
  else child.kill("SIGTERM");
}
