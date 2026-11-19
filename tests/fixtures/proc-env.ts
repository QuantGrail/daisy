/**
 * Processes whose environment holds `name=value` (P5-04): Linux reads
 * /proc/<pid>/environ; macOS has no /proc — `ps -E` prints each process's
 * environment after its command line (readable for this account's own
 * processes; platform binaries under SIP show none, the Node agents the
 * tests start show theirs). Both see the environment the process started
 * with. Zombies and exited processes are not listed.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function pidsWithEnv(name: string, value: string): number[] {
  const want = `${name}=${value}`;
  const out: number[] = [];
  if (process.platform === "linux") {
    for (const p of readdirSync("/proc")) {
      if (!/^\d+$/.test(p)) continue;
      try {
        const env = readFileSync(`/proc/${p}/environ`, "latin1").split("\0");
        if (env.includes(want)) out.push(Number(p));
      } catch {
        /* gone, or not ours */
      }
    }
    return out;
  }
  if (process.platform === "win32") {
    // Windows (P5-05): no way to read another process's environment — the
    // fake agent (agent.cjs) writes its own test variables, by pid; only
    // those still running count.
    const dir = join(tmpdir(), "daisy-fixture-env");
    const [k, v] = [name, value];
    for (const f of (() => {
      try {
        return readdirSync(dir);
      } catch {
        return [];
      }
    })()) {
      const pid = Number(f.replace(/\.json$/, ""));
      try {
        if (JSON.parse(readFileSync(join(dir, f), "utf8"))[k] !== v) continue;
        process.kill(pid, 0);
        out.push(pid);
      } catch {}
    }
    return out;
  }
  const text = execFileSync("ps", ["-axE", "-ww", "-o", "pid=,stat=,command="], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, LC_ALL: "C" },
  });
  const word = new RegExp(`(^|\\s)${want.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s|$)`);
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\s+(\S+)\s(.*)$/.exec(line);
    if (!m || m[2].startsWith("Z")) continue;
    if (word.test(m[3])) out.push(Number(m[1]));
  }
  return out;
}
