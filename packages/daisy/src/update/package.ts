/**
 * P5-06 (ADR-145): updating the whole Daisy when it was installed with npm
 * (D-41 ④: npm only for now — `npm install -g`, the same command on
 * Linux, macOS and Windows).
 *
 * What an update is here: the package `@daisy-ai/daisy` in npm's global
 * prefix is replaced by a newer one, and the Daisy process restarts into
 * it. Around that:
 *
 *   1. found — `updateSource` (runner.json; default npm's `latest` of the
 *      package) is looked at now and then; a newer version is copied or
 *      downloaded into `<data>/update/incoming/` and read (name, version,
 *      `.release`) before anything else happens. Only forward, unless the
 *      owner asks for an older one by name.
 *   2. waits — until the process is completely idle (the in-process
 *      Runner's idleness, a bounded wait for background work —
 *      restart-drain.ts); an auto-update never interrupts a turn.
 *   3. backs up — the database (`VACUUM INTO backups/daisy-update-…`),
 *      before anything is installed. No backup, no update.
 *   4. keeps a way back — the running release packed as
 *      `<data>/update/packages/<release>.tgz` (done once a release has
 *      confirmed it starts; again now if missing).
 *   5. installs — `npm install -g --prefix <the prefix it runs from> <tgz>`,
 *      then loads the new code's modules in a separate process (smoke). A
 *      failed install or smoke reinstalls the running release's package
 *      and Daisy keeps running as it was.
 *   6. switches — `update/pending.json` names from / to / backup / way
 *      back; the process exits for a restart (75: systemd / launchd start it
 *      again; `daisy start`'s background process starts its successor
 *      itself — restart.ts `respawn`).
 *   7. confirms or rolls back — guard.ts, at the new process's start: it
 *      must come up healthy (local face answering, Runner synced) within
 *      CONFIRM_MS; an exit before that, a timeout, or MAX_STARTS starts
 *      without it reinstall the previous package and restart into it.
 *
 * Every outcome is a record in `update/state.json` (history) and goes to
 * the audit log once the process is up (`update.applied`,
 * `update.rolled_back`, `update.failed`); `daisy status` / `daisy update`
 * show the last one.
 *
 * Only `node:` modules here: guard.ts loads this before the rest of Daisy,
 * and a broken newer Daisy must not take the guard down with it.
 */
import { FALLBACK_LANG, translator, type MessageKey, type Translate } from "../../../contracts/src/i18n.ts";
import { shippedPacks } from "../../../contracts/src/i18n-node.ts";
import { ownerT } from "../platform/language.ts";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, posix, resolve, sep, win32 } from "node:path";
import { randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";

const english = () => translator(shippedPacks(), FALLBACK_LANG);
const exitText = (code: number | null) => ownerT()("server-platform.exitCode", { code: String(code) });
const npmExit = (code: number | null) => ownerT()("server-update.npmExit", { code: String(code) });

/** The package (ADR-105, D-33). */
export const PACKAGE_NAME = "@daisy-ai/daisy";
/**
 * No default source (dispatcher, P5-06 review): the package is private and
 * the `@daisy-ai` scope not yet registered — a default of npm's `latest`
 * would let whoever claims the scope push code into every Daisy. A source
 * is used only when the owner configured one (runner.json `updateSource`
 * through `daisy update --source`, with the PIN; or `DAISY_UPDATE_SOURCE`).
 * The registry is for after the scope is registered and the package is
 * published; a team's shared directory of `.tgz` works today.
 */
export const NPM_SOURCE_EXAMPLE = `npm:${PACKAGE_NAME}@latest`;
/** What status and `daisy update --check` say while no source is set. */
export const noSourceText = (t: Translate = ownerT()): string => t("server-update.noSource", { example: NPM_SOURCE_EXAMPLE });
/** How often the source is looked at. */
export const DISCOVER_MS = 30 * 60_000;
/** A new release must be healthy within this, or it is rolled back. */
export const CONFIRM_MS = 120_000;
/** Starts of a new release without becoming healthy before it is rolled back. */
export const MAX_STARTS = 3;
/** Continuous idleness before an automatic update (as upgrade.ts). */
export const AUTO_IDLE_MS = 60_000;
/** Packages of earlier releases kept for rolling back. */
export const KEEP_PACKAGES = 3;
const BACKOFF_MS = 60_000;
const BACKOFF_MAX_MS = 6 * 3600_000;
const HISTORY = 20;

// ── where things are ─────────────────────────────────────────────────────

export const updateDir = (dataDir: string) => join(dataDir, "update");
export const pendingFile = (dataDir: string) => join(updateDir(dataDir), "pending.json");
export const stateFile = (dataDir: string) => join(updateDir(dataDir), "state.json");
export const packagesDir = (dataDir: string) => join(updateDir(dataDir), "packages");
export const incomingDir = (dataDir: string) => join(updateDir(dataDir), "incoming");
export const logFileOf = (dataDir: string) => join(dataDir, "logs", "daisy.log");

/**
 * npm's global prefix this code was installed into, or null (a checkout,
 * a project-local install). npm puts a global package at
 * `<prefix>/lib/node_modules/<name>` (Linux, macOS) and
 * `<prefix>\node_modules\<name>` (Windows).
 */
export function globalPrefix(codeRoot: string, platform: NodeJS.Platform = process.platform): string | null {
  // POSIX rules for POSIX systems whatever the host is (P5-05).
  const parts = (platform === "win32" ? win32.resolve(codeRoot) : posix.resolve(codeRoot)).split(platform === "win32" ? /[\\/]/ : "/");
  const n = parts.length;
  if (n < 4 || parts[n - 2] !== "@daisy-ai" || parts[n - 1] !== "daisy" || parts[n - 3] !== "node_modules") return null;
  if (platform === "win32") return parts.slice(0, n - 3).join("\\");
  if (parts[n - 4] !== "lib") return null;
  return parts.slice(0, n - 4).join("/") || "/";
}

/** `.release` of the code at `root` (written by the packer), else null. */
export function releaseAt(root: string): string | null {
  try {
    const v = readFileSync(join(root, ".release"), "utf8").trim();
    return /^[\w.+-]{1,100}$/.test(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * How to run npm without a shell: npm's own CLI script with this node
 * (Windows refuses to spawn `npm.cmd` without a shell). Layouts: next to
 * node.exe (Windows), `<prefix>/lib/node_modules/npm` (Linux, macOS,
 * Homebrew, nvm). Else `npm` from the PATH.
 */
export function npmCommand(
  node = process.execPath,
  platform: NodeJS.Platform = process.platform,
  exists: (p: string) => boolean = existsSync,
): { cmd: string; args: string[] } {
  const dir = dirname(node);
  const candidates =
    platform === "win32"
      ? [join(dir, "node_modules", "npm", "bin", "npm-cli.js")]
      : [join(dir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"), join(dir, "node_modules", "npm", "bin", "npm-cli.js")];
  for (const c of candidates) if (exists(c)) return { cmd: node, args: [resolve(c)] };
  return { cmd: "npm", args: [] };
}

// ── packages: reading one, versions ──────────────────────────────────────

export interface PackageInfo {
  name: string;
  version: string;
  /** `.release` inside the package (null: an install without one). */
  release: string | null;
  /**
   * package.json `daisy.updateGuard` (pack-daisy.ts): the release carries
   * the start guard (update/guard.ts) that confirms or rolls back a switch.
   * null: an older build — it could never be confirmed nor rolled back.
   */
  updateGuard: number | null;
}

/** The start guard's version our packages declare (package.json `daisy.updateGuard`). */
export const UPDATE_GUARD = 1;
// (NO_GUARD's text: `server-update.package.noGuard`.)

/**
 * name / version / `.release` of an npm tarball (`package/…`), read here
 * — nothing in it runs, nothing is unpacked to disk.
 */
export function readPackage(file: string): PackageInfo {
  const tar = gunzipSync(readFileSync(file));
  const want = new Map<string, string>();
  let longName: string | null = null;
  for (let at = 0; at + 512 <= tar.length; ) {
    const h = tar.subarray(at, at + 512);
    if (h.every((b) => b === 0)) break;
    const str = (a: number, b: number) => h.subarray(a, b).toString("utf8").replace(/\0.*$/s, "");
    const size = parseInt(str(124, 136).trim() || "0", 8) || 0;
    const type = String.fromCharCode(h[156] || 48);
    const prefix = str(345, 500);
    let name = longName ?? (prefix ? `${prefix}/${str(0, 100)}` : str(0, 100));
    longName = null;
    const body = tar.subarray(at + 512, at + 512 + size);
    if (type === "x") {
      const m = /\d+ path=([^\n]*)\n/.exec(body.toString("utf8"));
      if (m) longName = m[1]!;
    } else if (type === "0" || type === "\0") {
      name = name.replace(/^[^/]+\//, "");
      if (name === "package.json" || name === ".release") want.set(name, body.toString("utf8"));
    }
    at += 512 + Math.ceil(size / 512) * 512;
  }
  const pkg = want.get("package.json");
  if (!pkg) throw new Error(ownerT()("server-update.package.notNpm", { file: basename(file) }));
  let j: any;
  try {
    j = JSON.parse(pkg);
  } catch {
    throw new Error(ownerT()("server-update.package.badPackageJson", { file: basename(file) }));
  }
  const rel = want.get(".release")?.trim() ?? null;
  const guard = Number(j?.daisy?.updateGuard);
  return {
    name: String(j.name ?? ""),
    version: String(j.version ?? ""),
    release: rel && /^[\w.+-]{1,100}$/.test(rel) ? rel : null,
    updateGuard: Number.isInteger(guard) && guard >= 1 ? guard : null,
  };
}

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** Semantic-version order: <0 a is older, 0 the same version, >0 newer. Build metadata is ignored. */
export function compareVersions(a: string, b: string): number {
  const x = SEMVER.exec(a),
    y = SEMVER.exec(b);
  if (!x || !y) return a.localeCompare(b, "en", { numeric: true });
  for (let i = 1; i <= 3; i++) if (Number(x[i]) !== Number(y[i])) return Number(x[i]) - Number(y[i]);
  const p = x[4],
    q = y[4];
  if (!p || !q) return p ? -1 : q ? 1 : 0;
  const ps = p.split("."),
    qs = q.split(".");
  for (let i = 0; i < Math.max(ps.length, qs.length); i++) {
    const u = ps[i],
      v = qs[i];
    if (u === undefined) return -1;
    if (v === undefined) return 1;
    const nu = /^\d+$/.test(u),
      nv = /^\d+$/.test(v);
    if (nu && nv && Number(u) !== Number(v)) return Number(u) - Number(v);
    if (nu !== nv) return nu ? -1 : 1;
    if (u !== v) return u < v ? -1 : 1;
  }
  return 0;
}

/** The version part of a release (`0.2.0+abc` → `0.2.0`). */
export const versionOf = (release: string | null) => (release ?? "").replace(/\+.*$/, "");

// ── where updates come from ──────────────────────────────────────────────

export type Source =
  | { kind: "npm"; spec: string }
  | { kind: "dir"; dir: string }
  | { kind: "file"; file: string }
  | { kind: "off" }
  /** Nothing configured (the default). */
  | { kind: "none" };

/**
 * runner.json `updateSource`: `npm:<spec>` (a registry: `npm:@daisy-ai/daisy@latest`),
 * a directory of `.tgz` files (a team's shared folder), one `.tgz`, or `off`.
 * Unset: none — nothing is looked at.
 */
export function parseSource(s: string | undefined | null): Source {
  const v = (s ?? "").trim();
  if (!v) return { kind: "none" };
  if (v === "off") return { kind: "off" };
  if (v.startsWith("npm:")) return { kind: "npm", spec: v.slice(4) };
  if (/\.tgz$/i.test(v)) return { kind: "file", file: resolve(v) };
  return { kind: "dir", dir: resolve(v) };
}
export const describeSource = (s: Source, t: Translate = ownerT()) =>
  s.kind === "npm"
    ? t("server-update.source.npm", { spec: s.spec })
    : s.kind === "dir"
      ? t("server-update.source.dir", { dir: s.dir })
      : s.kind === "file"
        ? t("server-update.source.file", { file: s.file })
        : s.kind === "off"
          ? t("server-update.source.off")
          : t("server-update.source.none");
/** A source that is looked at (not unset, not off). */
export const sourceSet = (s: Source) => s.kind !== "none" && s.kind !== "off";

/**
 * Check what the owner sets as the source (`daisy update --source`): the
 * npm spec must name this package; a directory or `.tgz` must exist here
 * (absolute path). Returns the normalized value, or throws why not.
 */
export function validSource(v: string): string {
  const t = v.trim();
  if (t === "off") return t;
  if (t.startsWith("npm:")) {
    const spec = t.slice(4);
    if (!new RegExp(`^${PACKAGE_NAME.replace("/", "\\/")}(@[\\w.^~<>=*|-]{1,64})?$`).test(spec))
      throw new UpdateRefused((tr) => tr("server-update.source.npmOnly", { name: PACKAGE_NAME, example: NPM_SOURCE_EXAMPLE, spec }));
    return t;
  }
  if (!isAbsolute(t)) throw new UpdateRefused((tr) => tr("server-update.source.notAbsolute", { path: t }));
  let st;
  try {
    st = statSync(t);
  } catch {
    throw new UpdateRefused((tr) => tr("server-update.source.missing", { path: t }));
  }
  if (/\.tgz$/i.test(t) ? !st.isFile() : !st.isDirectory()) throw new UpdateRefused((tr) => tr("server-update.source.notTgz", { path: t }));
  return resolve(t);
}

/**
 * Write (or with null remove) runner.json `updateSource` (0600, atomically)
 * on top of `current` — the file as the caller read and judged it
 * (platform/settings.ts readRunnerJson; P6-16 review L6: never re-read
 * here, never started over from {} when it could not be parsed).
 */
export function writeSourceSetting(dataDir: string, value: string | null, current: Record<string, unknown>) {
  const file = join(dataDir, "runner.json");
  const j: Record<string, unknown> = { ...current };
  if (value === null) delete j.updateSource;
  else j.updateSource = value;
  writeJson(file, j);
}

export interface Candidate extends PackageInfo {
  /** The tarball, inside `<data>/update/incoming/`. */
  file: string;
}

export type Run = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv },
) => Promise<{ code: number; out: string; err: string }>;

export const run: Run = (cmd, args, opts = {}) =>
  new Promise((done) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let out = "",
      err = "";
    child.stdout.on("data", (d) => (out = (out + d).slice(-20_000)));
    child.stderr.on("data", (d) => (err = (err + d).slice(-20_000)));
    const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs ?? 600_000);
    child.on("error", (e) => {
      clearTimeout(timer);
      done({ code: 127, out, err: err + e.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ code: code ?? 1, out, err });
    });
  });

const tail = (s: string) => s.trim().split("\n").slice(-3).join(" ").slice(0, 400);

/** Copy `file` into incoming (the source may change; what is read is what is installed). */
export function takeIn(dataDir: string, file: string): Candidate {
  const dir = incomingDir(dataDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const info = readPackage(file);
  checkName(info, file);
  const dest = join(dir, `${(info.release ?? info.version).replace(/[^\w.-]/g, "_")}.tgz`);
  if (resolve(file) !== resolve(dest)) {
    copyFileSync(file, dest + ".tmp");
    renameSync(dest + ".tmp", dest);
  }
  const again = readPackage(dest);
  if (again.release !== info.release || again.version !== info.version) throw new Error(ownerT()("server-update.package.changedWhileCopying", { file: basename(file) }));
  return { ...again, file: dest };
}

function checkName(info: PackageInfo, file: string) {
  if (info.name !== PACKAGE_NAME) throw new Error(
      info.name
        ? ownerT()("server-update.package.wrongName", { file: basename(file), got: info.name, name: PACKAGE_NAME })
        : ownerT()("server-update.package.unnamed", { file: basename(file), name: PACKAGE_NAME }),
    );
  if (!SEMVER.test(info.version)) throw new Error(ownerT()("server-update.package.badVersion", { file: basename(file), version: info.version || "-" }));
  // Every package scripts/pack-daisy.ts makes has one; the start guard
  // tells releases apart by it.
  if (!info.release) throw new Error(ownerT()("server-update.package.noRelease", { file: basename(file) }));
  // A release without the start guard could never be confirmed or rolled back.
  if (!info.updateGuard) throw new Error(ownerT()("server-update.package.noGuard", { release: info.release, file }));
}

/**
 * ADR-145 §2: which target the owner may switch to. Newer: yes. The same
 * build: no (it is this one). The same version, another build (no telling
 * which is newer), or an older version: only with `allowDowngrade`.
 */
export function targetRefusal(
  c: PackageInfo,
  own: string | null,
  allowDowngrade: boolean,
  which: "running" | "installed" = "running",
): ((t: Translate) => string) | null {
  if (c.release && c.release === own) {
    const release = c.release;
    return (t) => t(which === "running" ? "server-update.target.sameRunning" : "server-update.target.sameInstalled", { release });
  }
  const order = compareVersions(c.version, versionOf(own));
  if (order === 0 && !allowDowngrade)
    return (t) =>
      t(which === "running" ? "server-update.target.sameVersionRunning" : "server-update.target.sameVersionInstalled", {
        target: c.release ?? c.version,
        own: String(own),
      });
  if (order < 0 && !allowDowngrade)
    return (t) =>
      t(which === "running" ? "server-update.target.olderRunning" : "server-update.target.olderInstalled", {
        version: c.version,
        own: String(versionOf(own)),
      });
  return null;
}

/**
 * The exact command that removes THIS install (`daisy uninstall` prints
 * it): its own npm prefix, quoted for this system's shell — another
 * install under another prefix is left alone.
 */
export function uninstallCommand(codeRoot: string, platform: NodeJS.Platform = process.platform): string {
  const prefix = globalPrefix(codeRoot, platform);
  if (!prefix) return `npm uninstall -g ${PACKAGE_NAME}`;
  const q =
    platform === "win32"
      ? /[\s&()^%!"]/.test(prefix)
        ? `"${prefix.replace(/"/g, '""')}"`
        : prefix
      : /^[\w@%+=:,./-]+$/.test(prefix)
        ? prefix
        : `'${prefix.replace(/'/g, "'\\''")}'`;
  return `npm uninstall -g --prefix ${q} ${PACKAGE_NAME}`;
}

/**
 * The newest package the source has (taken into incoming), or null when
 * it has none newer than `own` (by version; the owner names an older or
 * equal one explicitly with `daisy update --apply --from`).
 */
export async function latestFrom(
  source: Source,
  o: { dataDir: string; own: string | null; run?: Run; npm?: { cmd: string; args: string[] } },
): Promise<Candidate | null> {
  const ownVersion = versionOf(o.own);
  const newer = (v: string) => !ownVersion || compareVersions(v, ownVersion) > 0;
  if (source.kind === "off" || source.kind === "none") return null;
  if (source.kind === "file") {
    const info = readPackage(source.file);
    checkName(info, source.file);
    return newer(info.version) ? takeIn(o.dataDir, source.file) : null;
  }
  if (source.kind === "dir") {
    let best: { file: string; info: PackageInfo } | null = null;
    let names: string[];
    try {
      names = readdirSync(source.dir).filter((f) => f.endsWith(".tgz"));
    } catch (e: any) {
      throw new Error(ownerT()("server-update.fetch.dirUnreadable", { dir: source.dir, why: String(e?.code ?? e?.message) }));
    }
    for (const f of names) {
      let info: PackageInfo;
      try {
        info = readPackage(join(source.dir, f));
        checkName(info, f);
      } catch {
        continue;
      }
      if (!best || compareVersions(info.version, best.info.version) > 0) best = { file: join(source.dir, f), info };
    }
    return best && newer(best.info.version) ? takeIn(o.dataDir, best.file) : null;
  }
  // npm: what the registry's tag points at, then that exact version, packed
  // (downloaded and checked against the registry's integrity) into incoming.
  const r = o.run ?? run;
  const npm = o.npm ?? npmCommand();
  const view = await r(npm.cmd, [...npm.args, "view", source.spec, "version", "--json"], { timeoutMs: 120_000 });
  if (view.code !== 0) throw new Error(ownerT()("server-update.fetch.notFound", { spec: source.spec, why: tail(view.err) || npmExit(view.code) }));
  let version: string;
  try {
    const j = JSON.parse(view.out);
    version = String(Array.isArray(j) ? j.at(-1) : j);
  } catch {
    throw new Error(ownerT()("server-update.fetch.viewUnreadable", { spec: source.spec }));
  }
  if (!SEMVER.test(version)) throw new Error(ownerT()("server-update.fetch.badVersion", { version }));
  if (!newer(version)) return null;
  const dir = incomingDir(o.dataDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const p = await r(npm.cmd, [...npm.args, "pack", `${PACKAGE_NAME}@${version}`, "--pack-destination", dir, "--json"], { timeoutMs: 600_000 });
  if (p.code !== 0) throw new Error(ownerT()("server-update.fetch.downloadFailed", { pkg: `${PACKAGE_NAME}@${version}`, why: tail(p.err) || npmExit(p.code) }));
  let file: string;
  try {
    file = join(dir, JSON.parse(p.out)[0].filename);
  } catch {
    throw new Error(ownerT()("server-update.fetch.packUnreadable"));
  }
  return takeIn(o.dataDir, file);
}

// ── the steps ────────────────────────────────────────────────────────────

/** `npm install -g --prefix <prefix> <tgz>`: replaces the package where Daisy runs from. */
export async function installPackage(prefix: string, tgz: string, o: { run?: Run; npm?: { cmd: string; args: string[] } } = {}) {
  const npm = o.npm ?? npmCommand();
  const r = await (o.run ?? run)(
    npm.cmd,
    [...npm.args, "install", "-g", "--prefix", prefix, "--no-audit", "--no-fund", "--loglevel=error", tgz],
    { timeoutMs: 900_000 },
  );
  if (r.code !== 0) throw new Error(ownerT()("server-update.install.failed", { why: tail(r.err || r.out) || exitText(r.code) }));
}

/** The same, synchronously (the guard, from an exit handler). */
export function installPackageSync(prefix: string, tgz: string, npm = npmCommand()): { ok: boolean; error?: string } {
  const r = spawnSync(npm.cmd, [...npm.args, "install", "-g", "--prefix", prefix, "--no-audit", "--no-fund", "--loglevel=error", tgz], {
    encoding: "utf8",
    timeout: 900_000,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (r.status === 0) return { ok: true };
  return { ok: false, error: tail(String(r.stderr || r.stdout || r.error?.message || "")) || exitText(r.status) };
}

/**
 * The running release as a package (`npm pack` of the installed
 * directory: the files only — dependencies come from npm's cache when it
 * is installed again), into `<data>/update/packages/<release>.tgz`.
 */
/** Where the package of `release` is kept. */
export const keptPackage = (dataDir: string, release: string) => join(packagesDir(dataDir), `${release.replace(/[^\w.-]/g, "_")}.tgz`);

export async function keepPackage(dataDir: string, codeRoot: string, release: string, o: { run?: Run; npm?: { cmd: string; args: string[] } } = {}): Promise<string> {
  const dir = packagesDir(dataDir);
  const dest = keptPackage(dataDir, release);
  if (existsSync(dest)) return dest;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `.pack-${process.pid}-${Date.now()}`);
  mkdirSync(tmp, { recursive: true, mode: 0o700 });
  try {
    const npm = o.npm ?? npmCommand();
    const r = await (o.run ?? run)(npm.cmd, [...npm.args, "pack", codeRoot, "--pack-destination", tmp, "--json"], { timeoutMs: 300_000 });
    if (r.code !== 0) throw new Error(ownerT()("server-update.keep.packFailed", { why: tail(r.err) || npmExit(r.code) }));
    const made = readdirSync(tmp).find((f) => f.endsWith(".tgz"));
    if (!made) throw new Error(ownerT()("server-update.keep.noTgz"));
    const info = readPackage(join(tmp, made));
    if (info.release !== release) throw new Error(ownerT()("server-update.keep.wrongRelease", { got: info.release ?? "?", release }));
    renameSync(join(tmp, made), dest);
    try {
      chmodSync(dest, 0o600);
    } catch {}
    return dest;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Keep the newest KEEP_PACKAGES (and `keep`); incoming loses what was installed or refused. */
export function prunePackages(dataDir: string, keep: string[] = []) {
  for (const dir of [packagesDir(dataDir), incomingDir(dataDir)]) {
    let files: { f: string; t: number }[] = [];
    try {
      files = readdirSync(dir)
        .filter((f) => f.endsWith(".tgz"))
        .map((f) => ({ f: join(dir, f), t: statSync(join(dir, f)).mtimeMs }))
        .sort((a, b) => b.t - a.t);
    } catch {
      continue;
    }
    const limit = dir === packagesDir(dataDir) ? KEEP_PACKAGES : 2;
    for (const x of files.slice(limit)) if (!keep.includes(x.f)) rmSync(x.f, { force: true });
  }
}

/**
 * The new code loads, in a process of its own (nothing starts: the
 * application and the Runner's modules are imported, not run).
 */
export async function smokeCheck(codeRoot: string, o: { run?: Run } = {}): Promise<void> {
  const r = await (o.run ?? run)(
    process.execPath,
    [
      "--import",
      "tsx",
      "-e",
      // The guard too where the release has one (P5-06 and later).
      "await import('./packages/daisy/src/app.ts'); await import('./packages/daisy/src/turns/worker.ts'); " +
        "if ((await import('node:fs')).existsSync('./packages/daisy/src/update/guard.ts')) await import('./packages/daisy/src/update/guard.ts');",
    ],
    { cwd: codeRoot, timeoutMs: 180_000, env: { ...process.env, NODE_NO_WARNINGS: "1" } },
  );
  if (r.code !== 0) throw new Error(ownerT()("server-update.smokeFailed", { why: tail(r.err) || exitText(r.code) }));
}

// ── records ──────────────────────────────────────────────────────────────

export interface Pending {
  id: string;
  from: string | null;
  to: string;
  /** The way back: the previous release's package (null: none — no rollback possible). */
  fromPackage: string | null;
  toPackage: string | null;
  prefix: string | null;
  /** The database copy taken before (null: none yet). */
  backup: string | null;
  /** Taken by the new process before it opens the database (`daisy update --apply` while Daisy was not running). */
  backupAtStart?: boolean;
  at: number;
  by: "auto" | "owner" | "installed";
  starts: number;
  /** Why the new release is given up (set by the guard). */
  failed?: string;
  /** The previous package was reinstalled (by the guard). */
  rolledBack?: { at: number; ok: boolean; error?: string };
}

export interface UpdateRecord {
  id: string;
  at: number;
  from: string | null;
  to: string;
  result: "updated" | "rolled-back" | "failed";
  reason?: string;
  backup?: string | null;
  by: Pending["by"];
  /** Written to the audit log (by the running Daisy). */
  audited?: boolean;
}

export interface UpdateState {
  history?: UpdateRecord[];
  failures?: number;
  nextAt?: number;
  error?: string;
  errorAt?: number;
  /** The release a failure was about (its backoff); null: the source. */
  failedTarget?: string | null;
}

const readJson = <T>(p: string): T | null => {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
};
const writeJson = (p: string, v: unknown) => {
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  writeFileSync(p + ".tmp", JSON.stringify(v, null, 2) + "\n", { mode: 0o600 });
  renameSync(p + ".tmp", p);
};
export const readPending = (dataDir: string) => readJson<Pending>(pendingFile(dataDir));
export const writePending = (dataDir: string, p: Pending) => writeJson(pendingFile(dataDir), p);
export const clearPending = (dataDir: string) => rmSync(pendingFile(dataDir), { force: true });
export const readState = (dataDir: string): UpdateState => readJson<UpdateState>(stateFile(dataDir)) ?? {};
export const writeState = (dataDir: string, s: UpdateState) => writeJson(stateFile(dataDir), s);

/** Add an outcome to the history (newest last; a success clears the failure count). */
export function record(dataDir: string, r: Omit<UpdateRecord, "id" | "at"> & { id?: string; at?: number }): UpdateRecord {
  const st = readState(dataDir);
  const rec: UpdateRecord = { id: r.id ?? randomUUID(), at: r.at ?? Date.now(), ...r } as UpdateRecord;
  const history = [...(st.history ?? []).filter((h) => !(h.id === rec.id && h.result === rec.result)), rec].slice(-HISTORY);
  writeState(dataDir, {
    ...st,
    history,
    ...(rec.result === "updated" ? { failures: 0, nextAt: undefined, error: undefined, errorAt: undefined, failedTarget: undefined } : {}),
  });
  return rec;
}

export const backoff = (failures: number) => Math.min(BACKOFF_MS * 2 ** Math.max(0, failures - 1), BACKOFF_MAX_MS);

// ── the running process's side ───────────────────────────────────────────

export interface PackageStatus {
  /** This Daisy runs from an npm global install (else: why not). */
  supported: boolean;
  reason?: string;
  /** Updates found are applied by themselves once idle (D-34). */
  auto: boolean;
  source: string;
  /** A source is configured (no default: NO_SOURCE). */
  sourceSet: boolean;
  /** Exiting brings it back (restart.ts); without it nothing is applied. */
  restartable: boolean;
  running: string | null;
  /** The release on disk now. */
  installed: string | null;
  available: { version: string; release: string | null } | null;
  /** The owner asked for it (`daisy update --apply`): applied once idle even with auto off. */
  requested: boolean;
  state: "unsupported" | "no-source" | "current" | "available" | "waiting" | "updating" | "failed";
  checkedAt: number | null;
  error?: string;
  nextAt?: number;
  last: UpdateRecord | null;
  pending: Pending | null;
}

/**
 * What a node shows as its auto-update (`capabilities.runner.autoUpdate`,
 * read by `daisy status` and the settings page). P6-01 (ADR-151): only the
 * npm update's — the git-checkout updater is gone. D-34's switch
 * (runner.json `autoUpdate: false`) shows as "disabled", and a newer
 * release found then as "available" (the owner applies it).
 */
export interface NodeAutoUpdate {
  state: "unsupported" | "no-source" | "current" | "disabled" | "available" | "pending" | "failed";
  mode: "package";
  reason?: string;
  auto?: boolean;
  target?: string;
  error?: string;
  nextAt?: number;
  last?: { from: string | null; to: string; at: number; result: UpdateRecord["result"] };
  source?: string;
}
/** A Runner run without the npm updater (tests, embedders). */
export function nodeAutoUpdate(p: PackageStatus | null | undefined): NodeAutoUpdate {
  if (!p) return { state: "unsupported", mode: "package", reason: ownerT()("server-update.noUpdater") };
  if (!p.supported) return { state: "unsupported", mode: "package", ...(p.reason ? { reason: p.reason } : {}) };
  const state: NodeAutoUpdate["state"] =
    p.state === "no-source" || p.state === "failed"
      ? p.state
      : p.state === "waiting" || p.state === "updating"
        ? "pending"
        : p.state === "available"
          ? "available"
          : p.state === "current"
            ? p.auto ? "current" : "disabled"
            : "unsupported";
  return {
    state,
    mode: "package",
    auto: p.auto,
    ...(p.available ? { target: p.available.release ?? p.available.version } : {}),
    ...(p.error ? { error: p.error } : {}),
    ...(p.nextAt ? { nextAt: p.nextAt } : {}),
    ...(p.last ? { last: { from: p.last.from, to: p.last.to, at: p.last.at, result: p.last.result } } : {}),
    source: p.source,
  };
}

/** Why an update is refused: `say` in any language (the local API: the request's), `message` in the owner's. */
export class UpdateRefused extends Error {
  readonly say: (t: Translate) => string;
  constructor(why: string | ((t: Translate) => string)) {
    const say = typeof why === "string" ? () => why : why;
    super(say(ownerT()));
    this.say = say;
  }
}

export interface PackageUpdateOptions {
  codeRoot: string;
  dataDir: string;
  /** The release this process runs (`.release` at start). */
  own: string | null;
  /** runner.json `autoUpdate` (D-34: default on). */
  auto: boolean;
  /** runner.json `updateSource`. */
  source?: string;
  /** Exiting means a restart (restart.ts `supervision`). */
  restartable: () => boolean;
  /** The database copy (store/open.ts backupForUpdate). */
  backup: (from: string | null, to: string) => string | null;
  /** An audit line (store.audit). */
  audit?: (action: string, detail: string) => void;
  log?: (s: string) => void;
  idleMs?: number;
  requestIdleMs?: number;
  discoverMs?: number;
  now?: () => number;
  platform?: NodeJS.Platform;
  /** Tests: the steps that run npm and node. */
  steps?: Partial<{
    latest: typeof latestFrom;
    install: (prefix: string, tgz: string) => Promise<void>;
    keep: (release: string) => Promise<string>;
    smoke: () => Promise<void>;
  }>;
}

export class PackageUpdate {
  readonly prefix: string | null;
  source: Source;
  private candidate: Candidate | null = null;
  private requested: { by: "owner"; allowDowngrade: boolean } | null = null;
  private checking: Promise<void> | null = null;
  private checkedAt: number | null = null;
  private idleSince: number | null = null;
  private switching = false;
  private error: string | null = null;
  constructor(private o: PackageUpdateOptions) {
    this.prefix = globalPrefix(o.codeRoot, o.platform);
    this.source = parseSource(o.source);
  }
  private now() {
    return this.o.now?.() ?? Date.now();
  }
  private log(s: string) {
    (this.o.log ?? ((l: string) => process.stderr.write(l + "\n")))(`[update] ${s}`);
  }
  /** Why this Daisy cannot update itself (null: it can). */
  unsupported(): string | null {
    const key = this.unsupportedKey();
    return key ? ownerT().dynamic(key) : null;
  }
  /** `unsupported()` as a message key. */
  unsupportedKey(): MessageKey | null {
    if (!this.prefix) return "server-update.notGlobalInstall";
    if (!this.o.own) return "server-update.noReleaseMark";
    return null;
  }
  status(): PackageStatus {
    const st = readState(this.o.dataDir);
    const pending = readPending(this.o.dataDir);
    const why = this.unsupported();
    const c = this.candidate;
    const blocked = !!st.nextAt && st.nextAt > this.now() && (st.failedTarget == null || st.failedTarget === c?.release);
    return {
      supported: !why,
      ...(why ? { reason: why } : {}),
      auto: this.o.auto && this.source.kind !== "off",
      source: describeSource(this.source),
      sourceSet: sourceSet(this.source),
      restartable: this.o.restartable(),
      running: this.o.own,
      installed: releaseAt(this.o.codeRoot),
      available: c ? { version: c.version, release: c.release } : null,
      requested: !!this.requested,
      state: why
        ? "unsupported"
        : !c && !sourceSet(this.source) && !this.switching
          ? "no-source"
        : this.switching
          ? "updating"
          : blocked || (!c && this.error)
            ? "failed"
            : c
              ? this.wanted()
                ? "waiting"
                : "available"
              : "current",
      checkedAt: this.checkedAt,
      ...(this.error || st.error ? { error: this.error ?? st.error } : {}),
      ...(blocked ? { nextAt: st.nextAt } : {}),
      last: st.history?.at(-1) ?? null,
      pending,
    };
  }
  /** A found release will be applied once idle. */
  private wanted() {
    return !!this.candidate && (!!this.requested || (this.o.auto && sourceSet(this.source)));
  }
  /** Waiting only for idleness (restart.ts: a pending restart; restart-drain counts). */
  ready(): boolean {
    if (!this.wanted() || this.unsupported() || !this.o.restartable()) return false;
    const st = readState(this.o.dataDir);
    return !(st.nextAt && st.nextAt > this.now() && st.failedTarget === this.candidate!.release && !this.requested);
  }
  /** The owner set (or cleared, null) the source: from now on (runner.json is written by the caller). */
  setSource(value: string | null) {
    this.source = parseSource(value);
    if (!this.requested) this.candidate = null;
    this.checkedAt = null;
    this.error = null;
  }
  /** Look at the source now. */
  async check(): Promise<PackageStatus> {
    const why = this.unsupportedKey();
    if (why) throw new UpdateRefused((t) => t.dynamic(why));
    if (!sourceSet(this.source))
      throw new UpdateRefused((t) => (this.source.kind === "off" ? t("server-update.sourceOff") : noSourceText(t)));
    if (this.checking) await this.checking;
    else await (this.checking = this.discover().finally(() => (this.checking = null)));
    return this.status();
  }
  private async discover() {
    try {
      const c = await (this.o.steps?.latest ?? latestFrom)(this.source, { dataDir: this.o.dataDir, own: this.o.own });
      this.checkedAt = this.now();
      this.error = null;
      // The owner's explicit choice stays until it is applied or withdrawn.
      if (this.requested && this.candidate) return;
      if (c && c.release && c.release === this.o.own) return;
      if (c && (!this.candidate || this.candidate.release !== c.release)) this.log(`found a new release ${c.release ?? c.version} (${describeSource(this.source, english())})`);
      this.candidate = c;
    } catch (e) {
      this.checkedAt = this.now();
      this.error = (e as Error).message;
      this.log(`checking for updates failed: ${this.error}`);
    }
  }
  /**
   * The owner: apply (once idle) the newest the source has, or `from` (a
   * package file on this machine) — older or equal only with
   * `allowDowngrade`. Applied even when auto-update is off.
   */
  async apply(o: { from?: string; allowDowngrade?: boolean } = {}): Promise<PackageStatus> {
    const why = this.unsupportedKey();
    if (why) throw new UpdateRefused((t) => t.dynamic(why));
    if (!this.o.restartable()) throw new UpdateRefused((t) => t("server-update.notRestartable"));
    let c: Candidate;
    if (o.from) {
      const from = o.from;
      if (!/\.tgz$/i.test(from) || !existsSync(from)) throw new UpdateRefused((t) => t("server-update.notLocalTgz", { file: from }));
      try {
        c = takeIn(this.o.dataDir, resolve(from));
      } catch (e) {
        throw new UpdateRefused((e as Error).message);
      }
    } else {
      await this.check();
      const error = this.error;
      if (!this.candidate)
        throw new UpdateRefused((t) =>
          error ? t("server-update.checkFailed", { why: error }) : t("server-update.upToDate", { own: String(this.o.own) }),
        );
      c = this.candidate;
    }
    const refused = targetRefusal(c, this.o.own, !!o.allowDowngrade);
    if (refused) throw new UpdateRefused(refused);
    this.candidate = c;
    this.requested = { by: "owner", allowDowngrade: !!o.allowDowngrade };
    // An earlier failure of this release does not hold the owner's request.
    const st = readState(this.o.dataDir);
    if (st.nextAt) writeState(this.o.dataDir, { ...st, nextAt: undefined });
    this.log(`the owner asked for ${c.release ?? c.version}: applied once idle`);
    return this.status();
  }
  /** Withdraw what the owner asked (true: there was something). */
  withdraw(): boolean {
    const had = !!this.requested;
    this.requested = null;
    return had;
  }
  /**
   * Every loop pass of the Runner, with whether the process is idle (as
   * restart-drain decides it). Looks at the source now and then; once a
   * wanted release has waited out the idleness, switches to it. Returns
   * the release to restart into, or null.
   */
  async tick(idle: boolean): Promise<string | null> {
    const now = this.now();
    if (this.unsupported()) return null;
    if (!idle) this.idleSince = null;
    else this.idleSince ??= now;
    const st = readState(this.o.dataDir);
    const backingOff = !!st.nextAt && st.nextAt > now && st.failedTarget == null;
    if (
      this.o.auto &&
      sourceSet(this.source) &&
      !this.checking &&
      !backingOff &&
      (this.checkedAt === null || now - this.checkedAt >= (this.o.discoverMs ?? DISCOVER_MS))
    )
      this.checking = this.discover().finally(() => (this.checking = null));
    if (!this.ready() || this.idleSince === null) return null;
    const need = this.requested ? (this.o.requestIdleMs ?? 5_000) : (this.o.idleMs ?? AUTO_IDLE_MS);
    if (now - this.idleSince < need) return null;
    return this.switchTo(this.candidate!, this.requested ? "owner" : "auto");
  }
  /** A failure before the switch: counted, backed off, said. */
  private fail(target: string | null, message: string) {
    const st = readState(this.o.dataDir);
    const failures = (st.failedTarget === target ? (st.failures ?? 0) : 0) + 1;
    writeState(this.o.dataDir, { ...st, failures, nextAt: this.now() + backoff(failures), error: message, errorAt: this.now(), failedTarget: target });
    this.error = message;
    this.log(`updating to ${target ?? "?"} failed (${failures} time(s); next try in ${Math.round(backoff(failures) / 60_000)} min): ${message}`);
  }
  private outcome(r: Omit<UpdateRecord, "id" | "at">) {
    const rec = record(this.o.dataDir, r);
    this.auditNew();
    return rec;
  }
  /** History records not yet in the audit log go there (the guard cannot write it). */
  auditNew() {
    if (!this.o.audit) return;
    const st = readState(this.o.dataDir);
    let changed = false;
    for (const h of st.history ?? []) {
      if (h.audited) continue;
      const action = h.result === "updated" ? "update.applied" : h.result === "rolled-back" ? "update.rolled_back" : "update.failed";
      try {
        this.o.audit(action, JSON.stringify({ from: h.from, to: h.to, by: h.by, at: h.at, ...(h.reason ? { reason: h.reason.slice(0, 400) } : {}), ...(h.backup ? { backup: h.backup } : {}) }));
        h.audited = true;
        changed = true;
      } catch {}
    }
    if (changed) writeState(this.o.dataDir, { ...readState(this.o.dataDir), history: st.history });
  }
  /**
   * Switch to `c`: back up, keep the way back, install, check it loads,
   * write pending. Returns its release (the caller exits for a restart),
   * or null — nothing changed (a failure is recorded; a half-done install
   * is undone).
   */
  async switchTo(c: Candidate, by: "auto" | "owner"): Promise<string | null> {
    if (this.switching) return null;
    this.switching = true;
    const target = c.release ?? c.version;
    try {
      let backup: string | null;
      try {
        backup = this.o.backup(this.o.own, target);
      } catch (e) {
        this.fail(c.release, (e as Error).message);
        return null;
      }
      let fromPackage: string;
      try {
        fromPackage = await (this.o.steps?.keep ?? ((rel: string) => keepPackage(this.o.dataDir, this.o.codeRoot, rel)))(this.o.own!);
      } catch (e) {
        this.fail(c.release, ownerT()("server-update.keepFailed", { why: (e as Error).message }));
        return null;
      }
      this.log(`switching to ${target}: database backed up${backup ? ` (${backup})` : " (no database yet)"}, way back ${fromPackage}`);
      const install = this.o.steps?.install ?? ((prefix: string, tgz: string) => installPackage(prefix, tgz));
      try {
        await install(this.prefix!, c.file);
      } catch (e) {
        await this.undo(install, fromPackage);
        this.fail(c.release, (e as Error).message);
        this.outcome({ from: this.o.own, to: target, result: "failed", reason: (e as Error).message, backup, by });
        return null;
      }
      try {
        if (c.release && releaseAt(this.o.codeRoot) !== c.release)
          throw new Error(ownerT()("server-update.wrongOnDisk", { got: releaseAt(this.o.codeRoot) ?? "?", release: c.release }));
        await (this.o.steps?.smoke ?? (() => smokeCheck(this.o.codeRoot)))();
      } catch (e) {
        const undone = await this.undo(install, fromPackage);
        const t = ownerT();
        const reason = undone
          ? t("server-update.failedRolledBack", { why: (e as Error).message, own: String(this.o.own) })
          : t("server-update.failedRollbackFailed", { why: (e as Error).message });
        this.fail(c.release, reason);
        this.outcome({ from: this.o.own, to: target, result: "rolled-back", reason, backup, by });
        return null;
      }
      writePending(this.o.dataDir, {
        id: randomUUID(),
        from: this.o.own,
        to: target,
        fromPackage,
        toPackage: c.file,
        prefix: this.prefix,
        backup,
        at: this.now(),
        by,
        starts: 0,
      });
      this.requested = null;
      this.log(`${target} installed: exiting to restart as the new release (rolled back to ${this.o.own} unless healthy within ${Math.round(CONFIRM_MS / 1000)} s)`);
      return target;
    } finally {
      this.switching = false;
    }
  }
  /**
   * The code on disk changed under this process (someone ran `npm install
   * -g` of another release, upgrade.ts noticed). Back up and leave the
   * pending record so the new release confirms or rolls back like any
   * update. False: it does not load — the previous package went back.
   */
  async switchInstalled(target: string): Promise<boolean> {
    if (this.unsupported() || this.switching) return true;
    this.switching = true;
    try {
      let backup: string | null = null;
      try {
        backup = this.o.backup(this.o.own, target);
      } catch (e) {
        this.log(`newly installed ${target}: ${(e as Error).message} (switching anyway, without a backup from before the update)`);
      }
      const keep = keptPackage(this.o.dataDir, this.o.own ?? "");
      const fromPackage = existsSync(keep) ? keep : null;
      try {
        await (this.o.steps?.smoke ?? (() => smokeCheck(this.o.codeRoot)))();
      } catch (e) {
        const install = this.o.steps?.install ?? ((prefix: string, tgz: string) => installPackage(prefix, tgz));
        const undone = fromPackage ? await this.undo(install, fromPackage) : false;
        const reason = undone
          ? ownerT()("server-update.failedRolledBack", { why: (e as Error).message, own: String(this.o.own) })
          : ownerT()("server-update.failedNoWayBack", { why: (e as Error).message });
        this.outcome({ from: this.o.own, to: target, result: undone ? "rolled-back" : "failed", reason, backup, by: "installed" });
        if (undone) return false;
      }
      writePending(this.o.dataDir, {
        id: randomUUID(),
        from: this.o.own,
        to: target,
        fromPackage,
        toPackage: null,
        prefix: this.prefix,
        backup,
        at: this.now(),
        by: "installed",
        starts: 0,
      });
      return true;
    } finally {
      this.switching = false;
    }
  }
  private async undo(install: (prefix: string, tgz: string) => Promise<void>, fromPackage: string): Promise<boolean> {
    if (releaseAt(this.o.codeRoot) === this.o.own) return true;
    try {
      await install(this.prefix!, fromPackage);
      return releaseAt(this.o.codeRoot) === this.o.own;
    } catch (e) {
      this.log(`rolling back to ${this.o.own} failed: ${(e as Error).message}. By hand: npm install -g ${fromPackage}`);
      return false;
    }
  }
  /**
   * This release started healthy (guard.ts confirmed it): its own package
   * is kept for the next update's way back; old ones go; the history is
   * audited.
   */
  async settled(): Promise<void> {
    this.auditNew();
    if (this.unsupported()) return;
    try {
      const kept = await (this.o.steps?.keep ?? ((rel: string) => keepPackage(this.o.dataDir, this.o.codeRoot, rel)))(this.o.own!);
      prunePackages(this.o.dataDir, [kept]);
    } catch (e) {
      this.log(`could not keep this release's package (tried again at the next update): ${(e as Error).message}`);
    }
  }
}

// ── `daisy update --apply` while Daisy is not running ────────────────────

/**
 * The command line's own update when no Daisy runs on this data directory
 * (the same steps, nothing to wait for): keep the way back, install, check
 * it loads, and leave the pending record — the database is backed up by
 * the new release's first start before it opens it (daemon.ts,
 * `backupAtStart`), and its start guard confirms or rolls back as usual.
 * A failed install or smoke reinstalls the previous package here.
 */
export async function applyStopped(o: {
  dataDir: string;
  codeRoot: string;
  own: string | null;
  from?: string;
  source?: string;
  allowDowngrade?: boolean;
  platform?: NodeJS.Platform;
  steps?: PackageUpdateOptions["steps"];
}): Promise<{ to: string; fromPackage: string }> {
  const prefix = globalPrefix(o.codeRoot, o.platform);
  if (!prefix || !o.own) throw new UpdateRefused((t) => t("server-update.notGlobalInstall"));
  const pendingTo = readPending(o.dataDir)?.to;
  if (pendingTo) throw new UpdateRefused((t) => t("server-update.pendingUnconfirmed", { to: pendingTo }));
  let c: Candidate | null;
  if (o.from) {
    const from = o.from;
    if (!/\.tgz$/i.test(from) || !existsSync(from)) throw new UpdateRefused((t) => t("server-update.notLocalTgz", { file: from }));
    try {
      c = takeIn(o.dataDir, resolve(from));
    } catch (e) {
      throw new UpdateRefused((e as Error).message);
    }
  } else {
    const src = parseSource(o.source);
    if (!sourceSet(src))
      throw new UpdateRefused((t) =>
        src.kind === "off" ? t("server-update.sourceOffUseFrom") : t("server-update.noSourceUseFrom", { none: noSourceText(t) }),
      );
    c = await (o.steps?.latest ?? latestFrom)(src, { dataDir: o.dataDir, own: o.own });
  }
  const own = o.own;
  if (!c) throw new UpdateRefused((t) => t("server-update.upToDate", { own }));
  const refused = targetRefusal(c, o.own, !!o.allowDowngrade, "installed");
  if (refused) throw new UpdateRefused(refused);
  const to = c.release ?? c.version;
  const fromPackage = await (o.steps?.keep ?? ((rel: string) => keepPackage(o.dataDir, o.codeRoot, rel)))(o.own);
  const install = o.steps?.install ?? ((p: string, t: string) => installPackage(p, t));
  const undo = async () => {
    if (releaseAt(o.codeRoot) === o.own) return true;
    try {
      await install(prefix, fromPackage);
    } catch {}
    return releaseAt(o.codeRoot) === o.own;
  };
  try {
    await install(prefix, c.file);
    if (c.release && releaseAt(o.codeRoot) !== c.release)
      throw new Error(ownerT()("server-update.wrongOnDisk", { got: releaseAt(o.codeRoot) ?? "?", release: c.release }));
    await (o.steps?.smoke ?? (() => smokeCheck(o.codeRoot)))();
  } catch (e) {
    const back = await undo();
    const reason = back
      ? ownerT()("server-update.failedBack", { why: (e as Error).message, own })
      : ownerT()("server-update.failedBackFailed", { why: (e as Error).message, pkg: fromPackage });
    record(o.dataDir, { from: o.own, to, result: back ? "rolled-back" : "failed", reason, backup: null, by: "owner" });
    throw new UpdateRefused(reason);
  }
  writePending(o.dataDir, {
    id: randomUUID(),
    from: o.own,
    to,
    fromPackage,
    toPackage: c.file,
    prefix,
    backup: null,
    backupAtStart: true,
    at: Date.now(),
    by: "owner",
    starts: 0,
  });
  return { to, fromPackage };
}

/** The newest kept package of a release other than `own` (`daisy update --rollback`). */
export function previousPackage(dataDir: string, own: string | null): string | null {
  try {
    const dir = packagesDir(dataDir);
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".tgz"))
      .map((f) => join(dir, f))
      .filter((f) => {
        try {
          return readPackage(f).release !== own;
        } catch {
          return false;
        }
      })
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    return files[0] ?? null;
  } catch {
    return null;
  }
}
