/**
 * P1-10 / P6-00: the plugin seam's child run, shared by tests/plugin-seam.test.ts
 * and a plugin package's own seam tests. The control plane + Runner in a
 * fresh process (tests/fixtures/plugin-seam-child.ts), one turn on the fake
 * CLI, every module it loaded logged (tests/fixtures/plugin-seam-hooks.mjs).
 */
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { sockPath } from "./sock-path.ts";

export const root = resolve(import.meta.dirname, "..", "..");

export interface ChildRun {
  result: any;
  loaded: string[];
  /** Imports the uninstalled plugin's package was asked for (PLUGIN_SEAM_UNINSTALL). */
  blocked: string[];
  /** Connections to the watched socket (`socketEnv`). */
  connections: number;
}

/** Every plugin package in this tree: { name, dir } (a package.json exporting ./server or ./runner). */
export function pluginPackages(): { name: string; dir: string }[] {
  const out: { name: string; dir: string }[] = [];
  for (const parent of ["packages", "tests/plugins"])
    for (const d of readdirSync(join(root, parent))) {
      let pkg: any;
      try {
        pkg = JSON.parse(readFileSync(join(root, parent, d, "package.json"), "utf8"));
      } catch {
        continue;
      }
      if (pkg.exports?.["./server"] || pkg.exports?.["./runner"]) out.push({ name: pkg.name, dir: `${parent}/${d}` });
    }
  return out;
}

/**
 * Run the child with `env`. With `socketEnv`, a Unix socket is listened on and
 * its path passed in that variable; `connections` counts who touched it.
 */
export async function seamChild(
  env: Record<string, string | undefined>,
  { socketEnv }: { socketEnv?: string } = {},
): Promise<ChildRun> {
  const dir = mkdtempSync(join(tmpdir(), "daisy-plugin-seam-"));
  const log = join(dir, "loaded.txt");
  let connections = 0;
  const server = socketEnv
    ? createServer((c) => {
        connections++;
        c.destroy();
      })
    : null;
  const socket = sockPath(dir, "plugin.sock");
  if (server) await new Promise<void>((ok) => server.listen(socket, ok));
  try {
    const out = await new Promise<string>((ok, fail) => {
      const p = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          "--import",
          // A URL: on Windows --import of an absolute path (D:\…) is not one.
          pathToFileURL(join(root, "tests/fixtures/plugin-seam-hooks.mjs")).href,
          join(root, "tests/fixtures/plugin-seam-child.ts"),
        ],
        {
          cwd: root,
          env: {
            ...process.env,
            DAISY_PLUGINS: undefined,
            ...(socketEnv ? { [socketEnv]: socket } : {}),
            PLUGIN_SEAM_LOAD_LOG: log,
            ...env,
          } as NodeJS.ProcessEnv,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stdout = "",
        stderr = "";
      p.stdout.on("data", (c) => (stdout += c));
      p.stderr.on("data", (c) => (stderr += c));
      const timer = setTimeout(() => p.kill("SIGKILL"), 60_000);
      p.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) ok(stdout);
        else fail(Error(`child exited ${code}\n${stdout}\n${stderr}`.slice(-4000)));
      });
    });
    const line = out.split("\n").find((l) => l.startsWith("RESULT "));
    assert.ok(line, out.slice(-2000));
    const logged = readFileSync(log, "utf8").split("\n");
    return {
      result: JSON.parse(line!.slice(7)),
      loaded: logged.filter((u) => u.startsWith("file://")).map((u) => decodeURIComponent(new URL(u).pathname)),
      blocked: logged.filter((u) => u.startsWith("blocked ")).map((u) => u.slice(8)),
      connections,
    };
  } finally {
    if (server) await new Promise((ok) => server.close(ok));
    rmSync(dir, { recursive: true, force: true });
  }
}
