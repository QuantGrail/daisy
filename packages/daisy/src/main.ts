/**
 * The Daisy process's entry (`node --import tsx main.ts`: `daisy start`,
 * the systemd unit, the launchd plist). P5-06 (ADR-145): before anything
 * else is loaded, the start guard (update/guard.ts) looks at an update
 * under way — a new release on trial, or the previous one back after a
 * rollback. Only then the process itself (daemon.ts) is loaded: a newer
 * release that cannot even load is caught here, and the previous one goes
 * back in place.
 *
 * Only node: modules and the small update/paths/settings modules are
 * imported statically, for the same reason (and because runner.json's
 * start settings must be in the environment before the harness table
 * loads, platform/settings.ts).
 */
import { resolve } from "node:path";
import { startDataDir } from "./platform/paths.ts";
import { applyStartSettings } from "./platform/settings.ts";
import { releaseAt } from "./update/package.ts";
import { StartGuard, setGuard, waitForPredecessor } from "./update/guard.ts";
import { ownerOnlyUmask } from "./platform/umask.ts";

// P6-15 (ADR-158, P5N-1): before anything is written — whatever this
// process creates under the data directory is owner-only, however it was
// started (`daisy start` from a shell, launchd, systemd, in the foreground).
{
  const u = ownerOnlyUmask();
  if (u?.note) process.stderr.write(`! ${u.note}\n`);
}

const root = resolve(import.meta.dirname, "../../..");
// A successor started by its predecessor (restart.ts `respawn`): the data
// lock is free once that one is gone.
await waitForPredecessor(process.env);
delete process.env.DAISY_RESPAWN_AFTER;
const dataDir = startDataDir(root).dir;
// P6-11 (ADR-156): runner.json's start settings (an autostarted Daisy has
// no shell environment) before the harness table loads with daemon.ts.
applyStartSettings(dataDir);
const guard = new StartGuard({ dataDir, own: releaseAt(root) });
setGuard(guard);
if (guard.begin()) {
  try {
    await import("./daemon.ts");
  } catch (e) {
    guard.loadFailed(e);
    process.stderr.write(`✗ ${(e as Error)?.stack ?? e}\n`);
    process.exit(1);
  }
}
