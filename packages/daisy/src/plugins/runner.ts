/**
 * P1-10: the plugin seam, Runner side (the control-plane side is
 * packages/daisy/src/plugins/server.ts). Two hooks, nothing else:
 *
 *   1. session start — what a session's harness process starts with: the
 *      environment variables a plugin adds to it (`sessionEnv`), and the
 *      organisation's core text it reads for the layered prompt
 *      (`sync` / `tick`, reported to the control plane, which
 *      composes it into the prompt);
 *   2. external events — a plugin subscribes to something outside Daisy
 *      (`tick`) and hands what concerns a session to its control-plane
 *      half, which wakes that session.
 *
 * Off by default. A plugin is enabled only by name — `plugins` in the
 * node's config (runner.json), else the environment variable
 * `DAISY_PLUGINS` (comma-separated) — and only then is its code imported.
 * Nothing enabled: no plugin module is loaded and none of a plugin's
 * environment variables, paths or commands is read or touched.
 */
import { ownerT } from "../platform/language.ts";
import { existsSync, realpathSync } from "node:fs";
import { builtinModules } from "node:module";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `plugins` in a config: names, or `{ name: options | true | false }`.
 * Absent: `DAISY_PLUGINS`. Present (even empty): only what it says.
 */
export type PluginSelection =
  | string[]
  | Record<string, Record<string, unknown> | boolean>;

/** The scope of Daisy's own packages, and of plugins named by a short name. */
const OWN_SCOPE = "@daisy-ai";

/**
 * Not plugins: Daisy's own packages (and the two halves' names), so a
 * selection can never load core code as a plugin — neither by the short
 * name nor as `@daisy-ai/<name>`.
 */
const CORE_NAMES = [
  "server",
  "runner",
  "daisy",
  "contracts",
  "client",
  "ui",
  "app",
  "relay",
  "a2a-mcp",
  "a2a-client",
];

/** The short form (unchanged since P1-10): `my-plugin` → `@daisy-ai/my-plugin`. */
const SHORT = /^[a-z][a-z0-9-]{0,39}$/;
/**
 * One part of an npm package name (lower case, URL-safe, not starting with
 * `.` or `_`; review L8: nor ending with `.` — Windows drops a trailing dot,
 * so `daisy.` would be the folder `daisy`).
 */
const NPM_PART = "[a-z0-9~-](?:[a-z0-9._~-]*[a-z0-9_~-])?";
const SCOPED = new RegExp(`^@${NPM_PART}/${NPM_PART}$`);
const UNSCOPED = new RegExp(`^${NPM_PART}$`);
/** Written before an unscoped package's full name: `npm:daisy-plugin-foo`. */
const NPM_PREFIX = "npm:";

/**
 * P6-16 (D-44 ②, ADR-160): which package a plugin name in the selection
 * means — only what the owner wrote, never a path, never a guess:
 *
 *   `my-plugin`           the short form (as before): `@daisy-ai/my-plugin`;
 *   `@acme/daisy-foo`     a scoped package, as written;
 *   `npm:daisy-plugin-x`  an unscoped package, as written after `npm:`
 *                         (a bare name is always the short form, so an
 *                         unscoped package is marked; `npm:@acme/x` = `@acme/x`).
 *
 * `name` is the plugin's key (selection, options, what it reports as its
 * name besides its package name): the short name for `@daisy-ai/<short>`,
 * else the package name (`npm:` kept for an unscoped one, so it never
 * collides with a short name). Throws for anything else — a relative or
 * absolute path, a URL, `node:`/`file:`, upper case, Daisy's own packages,
 * Node's built-in modules.
 */
export function pluginPackage(written: string): { name: string; pkg: string } {
  const n = String(written).trim();
  const bad = () =>
    Error(ownerT()("server-plugins.badName", { name: n.slice(0, 60), scope: OWN_SCOPE }));
  let pkg: string;
  if (SHORT.test(n)) pkg = `${OWN_SCOPE}/${n}`;
  else {
    const full = n.startsWith(NPM_PREFIX) ? n.slice(NPM_PREFIX.length) : n;
    const scoped = SCOPED.test(full);
    if (full.length > 214) throw bad();
    if (scoped) pkg = full;
    else if (n.startsWith(NPM_PREFIX) && UNSCOPED.test(full)) pkg = full;
    else throw bad();
    if (!scoped && (builtinModules.includes(full) || ["node_modules", "favicon.ico"].includes(full))) throw bad();
  }
  if (pkg.startsWith(`${OWN_SCOPE}/`)) {
    const short = pkg.slice(OWN_SCOPE.length + 1);
    if (CORE_NAMES.includes(short)) throw bad();
    if (SHORT.test(short)) return { name: short, pkg };
    return { name: pkg, pkg };
  }
  return { name: pkg.startsWith("@") ? pkg : NPM_PREFIX + pkg, pkg };
}

/** The plugins to load, with their options (name → options; see pluginPackage). */
export function pluginSelection(
  configured: PluginSelection | undefined,
  env: string | undefined = process.env.DAISY_PLUGINS,
): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  const add = (written: string, options: unknown) => {
    if (!String(written).trim()) return;
    const { name } = pluginPackage(written);
    out.set(
      name,
      options && typeof options === "object" && !Array.isArray(options)
        ? { ...(options as Record<string, unknown>) }
        : {},
    );
  };
  if (configured === undefined || configured === null) {
    for (const n of String(env ?? "").split(",")) add(n, {});
  } else if (Array.isArray(configured)) {
    for (const n of configured) add(n, {});
  } else if (typeof configured === "object") {
    for (const [n, o] of Object.entries(configured))
      if (o !== false) add(n, o);
  } else throw Error(ownerT()("server-plugins.badConfig"));
  return out;
}

/**
 * Whether a plugin's own `name` is the one it was enabled by: its key
 * (pluginPackage `name`) or its package name.
 */
export function pluginNameMatches(name: string, reported: unknown): boolean {
  return reported === name || reported === pluginPackage(name).pkg;
}

/**
 * A plugin is a package (P4-13, ADR-129) whose `./server` and `./runner`
 * exports are its two halves; which package, pluginPackage says (P6-16).
 * Imported only here, only for enabled names — the core names no plugin.
 * Resolved as Node resolves any import of Daisy's own code: from where
 * Daisy is installed upwards (ADR-160) — beside a global
 * `npm install -g @daisy-ai/daisy` that is npm's global `node_modules`,
 * where `npm install -g <plugin>` puts it. Not NODE_PATH (ES modules do
 * not read it), not the data directory.
 */
export async function importPlugin<T>(
  name: string,
  side: "server" | "runner",
): Promise<T> {
  const { pkg } = pluginPackage(name);
  const notInstalled = () => Error(ownerT()("server-plugins.notInstalled", { name, pkg }));
  // P6-16 review L1 / L2: only where Daisy is installed (pluginRoots) — not
  // a node_modules further up that Node would also look in (C:\node_modules
  // on Windows, which any account may create).
  const home = pluginRoots()
    .map((r) => join(r, ...pkg.split("/")))
    .find((d) => existsSync(join(d, "package.json")));
  if (!home) throw notInstalled();
  let url: string;
  try {
    // Resolved first and apart: an error here is about this package itself,
    // not about something the plugin's own code imports.
    url = import.meta.resolve(`${pkg}/${side}`);
  } catch (e: any) {
    const code = e?.code;
    const msg = String(e?.message ?? "");
    if (code === "ERR_MODULE_NOT_FOUND" && msg.includes(`'${pkg}'`)) throw notInstalled();
    if (code === "ERR_PACKAGE_PATH_NOT_EXPORTED")
      throw Error(
        ownerT()(side === "server" ? "server-plugins.noServerExport" : "server-plugins.noRunnerExport", { name, pkg, side }),
      );
    throw e;
  }
  // …and what it resolves to is that package's own file: not one a
  // tsconfig `paths` mapping (tsx applies the working directory's in a
  // checkout) or a package further up put in its place.
  const file = url.startsWith("file:") ? fileURLToPath(url) : url;
  const real = realpathSync(home);
  if (!file.startsWith(real + sep))
    throw Error(`Plugin "${name}": ${pkg}/${side} resolved to ${file}, outside where Daisy is installed (${home}); not loaded`);
  return (await import(url)) as T;
}

/**
 * P6-16 review L1 / L2: the node_modules folders a plugin may come from, in
 * Node's lookup order — those inside Daisy's own tree (a checkout's root
 * `node_modules`; an installed package's own), then, when Daisy is an
 * installed package, the `node_modules` it sits in (npm's global one,
 * where `npm install -g <plugin>` puts a plugin). Nothing above that.
 */
export function pluginRoots(from: string = import.meta.dirname): string[] {
  // This file is packages/daisy/src/plugins/runner.ts in a checkout and in
  // the installed package alike (scripts/pack-daisy.ts keeps the paths).
  const top = resolve(from, "..", "..", "..", "..");
  const roots: string[] = [];
  for (let d = from; ; d = dirname(d)) {
    if (basename(d) !== "node_modules") roots.push(join(d, "node_modules"));
    if (d === top || dirname(d) === d) break;
  }
  for (let d = dirname(top); dirname(d) !== d; d = dirname(d))
    if (basename(d) === "node_modules") {
      roots.push(d);
      break;
    }
  return roots;
}

export interface RunnerPluginHost {
  /** Its own options (`plugins.<name>` in runner.json; {} from DAISY_PLUGINS). */
  options: Record<string, unknown>;
  /** The control plane's Runner calls (in process, P1-02; were POST /api/runner<path>). */
  api: (path: string, body?: any) => Promise<any>;
  /** This Runner's state directory, and its key for this control plane / node. */
  stateRoot: string;
  stateKey: string;
  /** The OS user this Runner runs as. */
  user: string;
  log: (message: string) => void;
}

export interface DaisyRunnerPlugin {
  name: string;
  /** Hook 1: variables added to the harness process of a session (not a login flow). */
  sessionEnv?: (session: { id: string; agent: string }) => Record<string, string>;
  /**
   * The variables `sessionEnv` may set: removed wherever a process is not
   * the session's own work (title generation, the owner's `!` shell).
   */
  envKeys?: readonly string[];
  /**
   * Its own secrets on this machine (Claude Code read-rule paths, e.g.
   * `~/.config/<tool>/**`): a read-only sidecar never sees them
   * (turns/sidecar.ts `sidecarDenyRules`).
   */
  secretPaths?: readonly string[];
  /**
   * Each state sync's answer from the control plane (P1-02: was the
   * heartbeat's).
   */
  sync?: (state: any) => void;
  /**
   * Hooks 1 and 2: once per pass of the Runner's loop, before it claims
   * work; must not throw. A promise returned is waited for (at most
   * PLUGIN_TICK_WAIT_MS) before claiming.
   */
  tick?: () => Promise<void> | void;
  stop?: () => void;
}

export type RunnerPluginModule = {
  createRunnerPlugin: (
    host: RunnerPluginHost,
  ) => DaisyRunnerPlugin | Promise<DaisyRunnerPlugin>;
};

/** The longest a Runner waits for a plugin's tick before claiming work. */
export const PLUGIN_TICK_WAIT_MS = 6000;

/**
 * Plugins of the running Runners of this process (agentEnv reads them; it
 * has no config of its own). Empty unless a Runner enabled one.
 */
const active = new Set<DaisyRunnerPlugin>();

export async function loadRunnerPlugins(
  selection: Map<string, Record<string, unknown>>,
  host: Omit<RunnerPluginHost, "options">,
): Promise<DaisyRunnerPlugin[]> {
  const out: DaisyRunnerPlugin[] = [];
  for (const [name, options] of selection) {
    const mod = await importPlugin<RunnerPluginModule>(name, "runner");
    if (typeof mod.createRunnerPlugin !== "function")
      throw Error(ownerT()("server-plugins.noRunnerSide", { name }));
    const p = await mod.createRunnerPlugin({ ...host, options });
    if (!pluginNameMatches(name, p?.name))
      throw Error(ownerT()("server-plugins.wrongName", { name, got: String(p?.name).slice(0, 60) }));
    out.push(p);
  }
  return out;
}

export function activateRunnerPlugins(list: DaisyRunnerPlugin[]) {
  for (const p of list) active.add(p);
  return () => {
    for (const p of list) {
      active.delete(p);
      try {
        p.stop?.();
      } catch {}
    }
  };
}

/** Hook 1: what the enabled plugins add to a session's harness process. */
export function pluginSessionEnv(session: {
  id?: string;
  agent: string;
}): Record<string, string> {
  if (!session.id || !active.size) return {};
  const env: Record<string, string> = {};
  for (const p of active)
    Object.assign(env, p.sessionEnv?.({ id: session.id, agent: session.agent }));
  return env;
}

/** The variables the enabled plugins may set (see `envKeys`). */
export function pluginEnvKeys(): string[] {
  return [...active].flatMap((p) => [...(p.envKeys ?? [])]);
}

/** The secret paths the enabled plugins name (see `secretPaths`). */
export function pluginSecretPaths(): string[] {
  return [...active].flatMap((p) => [...(p.secretPaths ?? [])]);
}
