// Where a Daisy keeps its data (D-29, ADR-102). One data directory per owner.
//
//   DAISY_DATA (explicit) > the system's convention:
//     Linux    $XDG_DATA_HOME/daisy, else ~/.local/share/daisy
//     macOS    ~/Library/Application Support/Daisy
//     Windows  %LOCALAPPDATA%\Daisy, else ~\AppData\Local\Daisy
//
// Not ~/.daisy: daisy-sdk (PyPI) already uses it (plan 12.4).
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, posix, win32 } from "node:path";

export const DATA_DIR_NAME = { posix: "daisy", mac: "Daisy", windows: "Daisy" } as const;

export function dataDir(
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  // Not HARBOR_DATA (P1-04 review): P1-02's launch.sh exports it to the
  // data/ beside the releases, which holds the old system's harbor.sqlite;
  // honouring it there would refuse every start after an update.
  const explicit = env.DAISY_DATA;
  if (explicit) return platform === "win32" ? win32.resolve(explicit) : posix.resolve(explicit);
  if (platform === "win32") {
    const base = env.LOCALAPPDATA || win32.join(home, "AppData", "Local");
    return win32.join(base, DATA_DIR_NAME.windows);
  }
  // POSIX paths for POSIX systems, whatever this host is (tests compute them anywhere).
  if (platform === "darwin")
    return posix.join(home, "Library", "Application Support", DATA_DIR_NAME.mac);
  const xdg = env.XDG_DATA_HOME;
  return posix.join(xdg && xdg.startsWith("/") ? xdg : posix.join(home, ".local", "share"), DATA_DIR_NAME.posix);
}

/** Written at start-up with the ports in use; the CLI reads it (D-30). */
export function runtimeFile(dir: string): string {
  return join(dir, "runtime.json");
}

/**
 * The data directory of the process started from code at `root` (P1-04
 * review): a development checkout (`.git`, no `.release`) keeps
 * `<root>/.data` unless DAISY_DATA is set, so `npm start` in a checkout
 * never opens the owner's real data. An installed package or a release has
 * no `.git` (or has `.release`): the system's convention.
 */
export function startDataDir(
  root: string,
  env: Record<string, string | undefined> = process.env,
): { dir: string; dev: boolean } {
  const dev =
    !env.DAISY_DATA &&
    existsSync(join(root, ".git")) &&
    !existsSync(join(root, ".release"));
  return { dir: dev ? join(root, ".data") : dataDir(env), dev };
}

/**
 * P6-03 (ADR-153): a file or directory whose name changed from the old
 * "harbor" one. New ones are made under `fresh`; one that exists only under
 * its old name is still found and used there (never moved).
 */
export function renamedPath(fresh: string, old: string): string {
  return !existsSync(fresh) && existsSync(old) ? old : fresh;
}

/**
 * Where a Runner keeps its local state (result journal, managed identities,
 * per-session runtime files) when it is given no `identityRoot` — Daisy
 * itself always gives `<data>/runner` (daemon.ts). Not the data directory
 * (tests use this default). P6-03: was ~/.local/share/agent-harbor, which
 * is still used where it exists and the new one does not.
 */
export function defaultStateRoot(home: string = homedir()): string {
  return renamedPath(
    join(home, ".local", "share", "daisy-runner"),
    join(home, ".local", "share", "agent-harbor"),
  );
}
