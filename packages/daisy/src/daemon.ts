import { daisyEnv } from "../../contracts/src/env.ts";
import { PRODUCT_NAME } from "../../contracts/src/names.ts";
import { watchStopRequest } from "./platform/windows/stop.ts";
import {
  resolve,
  join,
  relative,
  isAbsolute,
  sep,
  dirname,
  basename,
} from "node:path";
import { startDataDir } from "./platform/paths.ts";
import { appliedStartSettings, readRunnerJson } from "./platform/settings.ts";
import { ACP_HARNESS_PROBLEMS } from "../../contracts/src/acp-harnesses.ts";
import { backupForUpdate, checkDataDir } from "./store/open.ts";
import { acquireDataLock } from "./store/data-lock.ts";
import { existsSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { runtimeFile } from "./platform/paths.ts";
import { bindPort, givenLocalPort } from "./access/ports.ts";
import { writeSecret } from "./access/keys.ts";
import { createApp } from "./app.ts";
import { Lifecycle, trackHttp } from "./update/lifecycle.ts";
import {
  runNode,
  NodeTokenRejected,
  type NodeConfig,
  type NodeExit,
} from "./turns/worker.ts";
import { RESTART_EXIT } from "./update/upgrade.ts";
import { ProcessRestart, StopAbort } from "./update/restart.ts";
import {
  configureProcessGroups,
  sweepOrphans,
} from "./platform/process-groups.ts";
import { installConsoleRedaction, log } from "./observe/log.ts";
import { comeback, guard, runnerSynced, startSuccessor } from "./update/guard.ts";
import { PackageUpdate } from "./update/package.ts";
/**
 * The Daisy process itself, loaded by main.ts once the start guard
 * (update/guard.ts, P5-06) has looked at an update under way.
 *
 * P1-02: one start command, one process (D-02). The control plane (HTTP,
 * the live socket, the database, the sweeps) and the Runner (claiming
 * work, driving the harness processes) run here together; the Runner's
 * calls go through an in-process port instead of /api/runner/*. No
 * supervisor, no standby process, no leadership lease, no Runner child.
 *
 * Exits:
 * - SIGTERM / SIGINT: the Runner stops (a turn running then ends as
 *   「中断」, nothing is replayed), then HTTP drains, then exit 0.
 * - a restart (an installed or built release once idle, or the owner's
 *   request, packages/daisy/src/update/restart.ts): the Runner has already
 *   finished or interrupted everything; HTTP drains; exit 75 so the
 *   service manager starts the process again.
 * - a crash: the next start's Runner finds the cut-off turns in its result
 *   journal and the control plane marks them 「中断」 (R-1, not replayed).
 */
// P1-11 (S-1): whatever a library prints goes through the same redaction
// as Daisy's own log lines.
installConsoleRedaction();
const root = resolve(import.meta.dirname, "../../..");
/**
 * P1-04 (D-29, ADR-102): the data directory is the owner's, by the
 * system's convention (paths.ts; DAISY_DATA overrides). A development
 * checkout (`.git`, no `.release`) keeps `<repo>/.data` unless DAISY_DATA
 * is set — not the owner's real data. Never inside a release directory (it
 * has `.release`, is read-only, and old ones are removed): data there would
 * be lost.
 */
const { dir: dataDir, dev: devCheckout } = startDataDir(root);
if (devCheckout)
  log.info(
    `development checkout: data directory ${dataDir} (not the owner's data directory; set DAISY_DATA for another place)`,
  );
if (process.env.HARBOR_DATA)
  log.warn(
    `HARBOR_DATA (${process.env.HARBOR_DATA}) is no longer used: the data directory is ${dataDir}. To choose the data directory use DAISY_DATA.`,
  );
/**
 * Through symlinks (macOS: /var → /private/var) and with the file
 * system's own spelling (case-insensitive volumes), the parts that exist.
 */
const real = (p: string): string => {
  try {
    return realpathSync.native(p);
  } catch {
    const up = dirname(p);
    return up === p ? p : join(real(up), basename(p));
  }
};
const inRelease = relative(real(root), real(dataDir));
if (
  existsSync(join(root, ".release")) &&
  inRelease !== ".." &&
  !inRelease.startsWith(`..${sep}`) &&
  !isAbsolute(inRelease)
) {
  log.error(
    `✗ the data directory ${dataDir} is inside the release directory ${root}: a release directory is read-only and old ones are removed, so data cannot live under it. Leave DAISY_DATA unset (the default place), or point it outside the release directory.`,
  );
  process.exit(1);
}
// D-31 (ADR-101): the local face listens on 127.0.0.1 only. Reaching this
// Daisy from another machine is the outside face (settings, with the PIN).
if (process.env.HOST && process.env.HOST !== "127.0.0.1") {
  log.error(
    `✗ HOST=${process.env.HOST}: the local face listens on 127.0.0.1 only. To open it from another machine, turn on the outside face in the settings (needs the PIN) and remove HOST`,
  );
  process.exit(1);
}
// P6-11 (ADR-156): a broken start setting (runner.json, the extra ACP
// harness file) does not stop the start: said here, kept in the runtime
// file for `daisy status`, the harnesses it names left out.
const startProblems = [...(appliedStartSettings()?.problems ?? []), ...ACP_HARNESS_PROBLEMS];
for (const p of startProblems) log.error(`✗ ${p}`);
// D-30: a port the owner gives is used as given (taken → refuse);
// otherwise derived from the uid, remembered (access/ports.ts). P6-11:
// runner.json `port` is in DAISY_PORT by now when neither is set (main.ts).
// P6-13: one rule wherever a port is given — an integer 1024–65535.
const given = givenLocalPort(process.env);
if (given.bad) {
  log.error(`✗ ${given.bad}: use a port between 1024 and 65535, or remove it and let ${PRODUCT_NAME} choose by its rule`);
  process.exit(1);
}
const givenPort = given.port;
// Host branding for the web app (presentation only; validated by createApp).
const brandingFile = daisyEnv("DAISY_BRANDING_FILE");
const brandingRaw =
  daisyEnv("DAISY_BRANDING") ||
  (brandingFile ? readFileSync(brandingFile, "utf8") : "");
let branding: unknown;
if (brandingRaw.trim())
  try {
    branding = JSON.parse(brandingRaw);
  } catch (e) {
    throw new Error(`DAISY_BRANDING is not valid JSON: ${(e as Error).message}`);
  }
// Q-1 (limits.md §1): how long a tool permission / question card waits
// for its owner (hours; default 24).
const cardTtlHours = Number(process.env.DAISY_CARD_TTL_HOURS);
const cardTtlMs =
  Number.isFinite(cardTtlHours) && cardTtlHours > 0
    ? Math.round(cardTtlHours * 3600_000)
    : undefined;
const drainMs = Number(daisyEnv("DAISY_DRAIN_MS")) || 5000;
const graceMs = Number(daisyEnv("DAISY_DRAIN_GRACE_MS") ?? 250);
const release = (() => {
  try {
    const v = readFileSync(join(root, ".release"), "utf8").trim();
    return /^[\w.+-]{1,100}$/.test(v) ? v : null;
  } catch {
    return null;
  }
})();
/**
 * The node's settings, runner.json (written on first start). P6-16
 * (ADR-160 §3–4, review M1/M2/L4/L5): read once, here, before anything
 * touches the data directory — the plugins, the update settings and the
 * trust verdict come from this one reading (the start's permission walk
 * cannot turn a planted file into a trusted one half way through). A file
 * another account owns or can write, or one that is not a JSON object:
 * Daisy does not start (it names the code Daisy runs, the identity homes
 * and the workspaces; defaults would run a different node).
 */
const runnerJson = readRunnerJson(dataDir);
if (runnerJson.distrust || runnerJson.broken) {
  log.error(
    runnerJson.distrust
      ? `✗ ${join(dataDir, "runner.json")} ${runnerJson.distrust} — not starting: this file decides which code Daisy runs and where (plugins, updates, identity homes, workspaces). Check what it says, make it this account's and owner-only (chmod go-w), then start again.`
      : `✗ ${runnerJson.broken} — not starting: fix it (or move it away), then start again.`,
  );
  process.exit(1);
}
type RunnerSettings = Omit<NodeConfig, "api">;
const runnerAtStart = runnerJson.config as RunnerSettings | null;
const localRunner = daisyEnv("DAISY_LOCAL_RUNNER") !== "0";

const lifecycle = new Lifecycle();
lifecycle.release = release;
const restart = new ProcessRestart();
// P1-02: one plugin selection for both halves (runner.json `plugins`, else
// DAISY_PLUGINS) — they used to be configured per process.
const plugins = runnerAtStart?.plugins;

// P1-04: the old system's database is refused before anything is written,
// then the data directory's lock: one Daisy per data directory (ADR-102).
try {
  checkDataDir(dataDir);
  acquireDataLock(dataDir);
} catch (e) {
  log.error(`✗ ${(e as Error).message}`);
  process.exit(1);
}
// P5-06: `daisy update --apply` while Daisy was not running installed this
// release; the database is backed up now, before this code opens it.
{
  const p = guard?.record;
  if (p?.backupAtStart && !p.backup)
    try {
      guard!.amend({ backup: backupForUpdate(dataDir, p.from, p.to), backupAtStart: false });
    } catch (e) {
      log.error(`✗ ${(e as Error).message}`);
      process.exit(1);
    }
}
let ctx: Awaited<ReturnType<typeof createApp>>;
try {
  ctx = await createApp({
    branding,
    bootstrapLocal: daisyEnv("DAISY_BOOTSTRAP_LOCAL") !== "0",
    dataDir,
    webDir: join(root, "apps/app/dist"),
    rateLimit: { user: Number(daisyEnv("DAISY_RATE_LIMIT")) || undefined },
    lifecycle,
    restart,
    cardTtlMs,
    ...(plugins !== undefined ? { plugins } : {}),
  });
} catch (e) {
  log.error(`✗ ${(e as Error).message}`);
  process.exit(1);
}
const app = ctx.app;
const { faces } = ctx.access;
// P5-06 (ADR-145): updating this Daisy when npm installed it — found,
// applied once idle by the Runner's loop, confirmed by the start guard.
const updateSettings = runnerAtStart;
const packageUpdate = new PackageUpdate({
  codeRoot: root,
  dataDir,
  own: release,
  // D-34: on by default (team-internal) now that every update is backed
  // up and rolled back; runner.json `autoUpdate: false` turns it off.
  auto: updateSettings?.autoUpdate !== false,
  source: updateSettings?.updateSource ?? process.env.DAISY_UPDATE_SOURCE,
  restartable: () => !!restart.status().supervision?.supervised,
  backup: (from, to) => backupForUpdate(dataDir, from, to),
  audit: (action, detail) => ctx.store.audit("system", action, detail),
  log: (s) => log.info(s),
  ...(updateSettings?.restartIdleMs ? { idleMs: updateSettings.restartIdleMs } : {}),
  ...(updateSettings?.restartRequestIdleMs ? { requestIdleMs: updateSettings.restartRequestIdleMs } : {}),
  ...(updateSettings?.updateDiscoverMs ? { discoverMs: updateSettings.updateDiscoverMs } : {}),
});
ctx.packageUpdate = packageUpdate;
await app.ready();
const http = trackHttp(app.server);
/**
 * The runtime file (D-30, ADR-102): where this Daisy listens, for the
 * command line (0600; it never guesses a port). Rewritten when the outside
 * face starts or stops; removed on exit.
 */
const writeRuntime = () =>
  writeSecret(
    runtimeFile(dataDir),
    JSON.stringify(
      {
        pid: process.pid,
        release,
        startedAt,
        dataDir,
        local: faces.local,
        external: faces.externalListening
          ? { url: faces.external.url, port: faces.external.port, tls: faces.external.tls }
          : null,
        cliCredential: ctx.access.cliFile,
        ...(startProblems.length ? { problems: startProblems } : {}),
      },
      null,
      2,
    ) + "\n",
  );
const startedAt = Date.now();
let local: Awaited<ReturnType<typeof bindPort>>;
try {
  local = await bindPort("local", { dataDir, given: givenPort }, (port) =>
    new Promise<void>((ok, fail) => {
      // The guard's Host check knows the port before the first request.
      faces.local = { ...faces.local, port };
      app.server.once("error", fail);
      app.server.listen({ port, host: "127.0.0.1", backlog: 4096 }, () => {
        app.server.off("error", fail);
        ok();
      });
    }),
  );
} catch (e) {
  log.error(`✗ the local face could not listen: ${(e as Error).message}`);
  process.exit(1);
}
faces.onChange = writeRuntime;
faces.setLocal(local.port, local.source);
if (local.source === "moved")
  log.info(
    `the remembered port ${local.preferred} is taken; using ${local.port} this time (the next start tries the old one first; to fix one, set DAISY_PORT or port in runner.json)`,
  );
// D-31: the outside face, if the owner turned it on.
const ext = faces.config();
if (ext.enabled)
  await faces.startExternal(ext).catch((e) =>
    log.error(`✗ the outside face could not start (the local face works as usual): ${(e as Error).message}`),
  );
// P5-02: the relay, if the owner chose one (connects out, keeps trying).
await ctx.relay.apply().catch((e) => log.error(`✗ the relay could not start (the local face works as usual): ${(e as Error).message}`));
log.info(
  // The whole release id (0.1.0+97a438c807b8), as `daisy --version` says.
  `${PRODUCT_NAME} ${release ?? "(dev)"} listening on ${faces.local.url}${faces.external.url ? ` and ${faces.external.url}` : ""}; data: ${dataDir}`,
);

const stopRunner = new AbortController();
let runner: Promise<NodeExit> | undefined;
// Read again: the first start's bootstrap has just written the node id.
// Judged again too; a file that changed for the worse meanwhile: no Runner.
const runnerNow = localRunner ? readRunnerJson(dataDir) : null;
if (runnerNow?.distrust || runnerNow?.broken)
  log.error(`✗ runner.json changed while Daisy was starting (${runnerNow.distrust ?? runnerNow.broken}): Runner not started.`);
const settings = runnerNow && !runnerNow.distrust && !runnerNow.broken ? (runnerNow.config as RunnerSettings | null) : null;
if (!localRunner) log.info("DAISY_LOCAL_RUNNER=0: Runner not started.");
else if (!settings)
  log.info(
    "No runner.json (DAISY_BOOTSTRAP_LOCAL=0): Runner not started.",
  );
else {
  // C-4: what a killed predecessor left running (harness CLIs, background
  // commands — each its own process group, recorded in the data
  // directory) ends before anything new starts.
  const groupsFile = join(dataDir, "process-groups.json");
  await sweepOrphans(groupsFile);
  configureProcessGroups(groupsFile);
  runner = runNode(
    {
      ...settings,
      plugins,
      // P1-04: the Runner's state (identities, plugin state; an old
      // results.sqlite to import, P1-02b) inside the data directory unless
      // runner.json says otherwise.
      identityRoot: settings.identityRoot ?? join(dataDir, "runner"),
      api: ctx.runnerApi(settings.nodeId),
    },
    stopRunner.signal,
    restart,
    packageUpdate,
  );
  runner.then(
    (exit) => {
      // Idle (or the owner confirmed what it interrupts): restart now.
      if (exit?.restart) void shutdown(RESTART_EXIT, "restart");
    },
    (e) => {
      // The node was revoked: the Runner stops, the rest keeps serving.
      if (e instanceof NodeTokenRejected) log.error(`✗ ${e.message}`);
      else {
        log.error("✗ Runner:", (e as Error)?.stack || e);
        void shutdown(1, "runner failed");
      }
    },
  );
}

/**
 * P5-06: healthy — the local face answers its health check and the Runner
 * (when there is one) synced once. Confirms a new release on trial, then
 * keeps this release's package for the next update's way back.
 */
void (async () => {
  try {
    if (runner) await runnerSynced;
    const r = await fetch(`${faces.local.url}/api/health`, { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw Error(`health check answered ${r.status}`);
    guard?.confirm();
    await packageUpdate.settled();
  } catch (e) {
    log.error(`✗ the health check after start did not pass: ${(e as Error).message}`);
  }
})();

let exiting = false;
/**
 * 「排空再退出」 (lifecycle.ts): the Runner ends first (its completions still
 * reach the control plane), then live sockets get 1012, requests in flight
 * finish, and the process exits.
 */
async function shutdown(code: number, why: string) {
  if (exiting) return;
  exiting = true;
  log.info(`Shutting down (${why})…`);
  // A turn running now ends 「中断」 with why — not replayed (R-1).
  stopRunner.abort(code === RESTART_EXIT ? undefined : new StopAbort());
  await Promise.race([
    runner?.catch(() => {}),
    new Promise((r) => setTimeout(r, 20_000)),
  ]);
  lifecycle.beginDrain();
  const r = await http.drain({ graceMs, timeoutMs: drainMs });
  if (r.stragglers)
    log.error(`[drain] ${r.stragglers} request(s) still running after ${drainMs} ms`);
  await app.close().catch(() => {});
  rmSync(runtimeFile(dataDir), { force: true });
  // P5-06: a background process `daisy start` ran has no service manager
  // to start it again: it starts its successor on the way out (after the
  // data lock is released; the successor waits for this pid to be gone).
  if (code === RESTART_EXIT && comeback(process.env) === "respawn")
    process.on("exit", () => {
      startSuccessor(dataDir);
    });
  process.exit(code);
}
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, () => void shutdown(0, signal));
// P5-05 (ADR-141): Windows has no SIGTERM for a process without a console —
// `daisy stop` writes a stop request instead.
if (process.platform === "win32")
  watchStopRequest(dataDir, () => void shutdown(0, "stop request"));
