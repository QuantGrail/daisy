/**
 * P1-10: the plugin seam, control-plane side (the Runner side, and how a
 * plugin is enabled, are in packages/daisy/src/plugins/runner.ts). Two hooks:
 *
 *   1. session start — the organisation's core text for the layered
 *      prompt (`sessionPrompt.orgCore` says which document it is and how
 *      an admin prints it; `readOrgCore` reads it): prompt-layers composes
 *      it into what a session starts with; the mechanism itself stays in
 *      the core;
 *   2. external events — `events.subscribe` gets what it needs to take
 *      events in (its routes) and wake a session (the scheduler);
 *      `events.wakeStopped` hears that a wake it queued was stopped before
 *      it ran; `events.jobs` keeps what it filed against a queued wake job
 *      in step when the queue merges or restores jobs;
 *   3. notification kinds (P6-14, ADR-157 § P6-14) — `notificationKinds`:
 *      the kinds of notification the plugin's own events are (id, label,
 *      hint, default), offered after the core's in the notification
 *      settings only while the plugin is installed and enabled.
 *
 * Off by default: nothing enabled → no plugin module is imported, none of
 * a plugin's routes, tables, environment variables or paths exist.
 * P4-13 (ADR-129): a plugin is a package of its own; the core names none
 * (scripts/check-core-names.mjs).
 */
import { ownerT } from "../platform/language.ts";
import type { FastifyInstance } from "fastify";
import type { Store } from "../store/index.ts";
import type { RunnerPort } from "../app/runner-port.ts";
import type { Scheduler } from "../schedule/scheduler.ts";
import {
  NOTIFICATION_KINDS,
  notificationKinds,
  type NotificationKindDecl,
  type NotificationKindInfo,
} from "../../../contracts/src/notifications.ts";
import {
  importPlugin,
  pluginNameMatches,
  pluginSelection,
  type PluginSelection,
} from "./runner.ts";

export type { PluginSelection } from "./runner.ts";

export interface ServerPluginHost {
  /** Its own options (`plugins.<name>` in createApp's options; {} from DAISY_PLUGINS). */
  options: Record<string, unknown>;
  store: Store;
}

/** What hook 2 is given once the scheduler exists. */
export interface EventHost {
  app: FastifyInstance;
  /**
   * P1-02: the in-process Runner's calls — a plugin's Runner half reaches
   * its server half here (`api(path)` on the Runner side).
   */
  runner: RunnerPort;
  store: Store;
  /** The Runner node a call comes from, or a 401/403. */
  claimingNode: (req: any) => any;
  /**
   * Wakes a session (`wake` / `hold` / `keepCallback`). A callback's
   * scheduleId comes from `callbackScheduleId` (ADR-157: the core knows
   * only that frame, the kinds and id shapes are the plugin's).
   */
  scheduler: Scheduler;
}

export interface WakeStopped {
  sessionId: string;
  scheduleId: string;
  jobId: string;
  result: "kept" | "held" | "gone";
}

/**
 * Hook 1: the document the org layer is. Absent (no plugin gives one): the
 * layered prompt has no org source — nothing is read or reported, and the
 * org layer is the one 「暂时取不到」 line.
 */
export interface OrgCoreSource {
  /** Its id (`AB-<hex>`, as reports carry it). */
  docId: string;
  /**
   * A shell command printing its body byte for byte — how an admin computes
   * the expected hash herself (`<command> | sha256sum`) and reads the full
   * text when the layer was trimmed.
   */
  rawCommand: string;
  /**
   * P6-17: how the organisation changes the core, in its own words (a
   * noun phrase, e.g. 「L1 议案」) — named where a session's settings say
   * why the core cannot be changed in Daisy. Absent: 「提供它的组织」.
   */
  changeVia?: string;
}

/**
 * Hook 2: what a plugin filed against a queued wake job (its dedupe rows),
 * kept in step by the queue (sessions/queue-merge.ts). Keys are opaque; a
 * key that is not the plugin's is simply not found.
 */
export interface JobBookkeeping {
  /** The keys filed against `jobId`. */
  keys: (jobId: string) => string[];
  /** File them (all of `from`'s, or only `keys`) against `into`. */
  move: (from: string, into: string, keys?: string[]) => void;
  /** Whether stopping `jobId` kept any of them for the next turn. */
  kept: (jobId: string) => boolean;
}

export interface DaisyServerPlugin {
  name: string;
  /** Hook 1: session start. */
  sessionPrompt?: {
    /** Which document the org layer is (see OrgCoreSource). */
    orgCore?: OrgCoreSource;
    /**
     * The organisation's core text, as `{ meta: { status, version }, body }`
     * (prompt-layers checks it). Rejects when it cannot be read.
     */
    readOrgCore?: (docId: string) => Promise<unknown>;
  };
  /** Hook 2: external events wake sessions. */
  events?: {
    subscribe: (host: EventHost) => void;
    wakeStopped?: (w: WakeStopped) => void;
    jobs?: JobBookkeeping;
  };
  /**
   * Hook 3: notification kinds of its own (ids unique, not a core kind's).
   * A person's settings for them are kept while the plugin is not enabled
   * and count again when it is.
   */
  notificationKinds?: NotificationKindDecl[];
}

export type ServerPluginModule = {
  createServerPlugin: (
    host: ServerPluginHost,
  ) => DaisyServerPlugin | Promise<DaisyServerPlugin>;
};

export interface ServerPlugins {
  /** Enabled plugins, by name (empty by default). */
  names: string[];
  /** Hook 1: the first enabled plugin's org document (none: absent). */
  orgCore?: OrgCoreSource;
  /** Hook 1: the first enabled plugin's org-core reader (none: absent). */
  readOrgCore?: (docId: string) => Promise<unknown>;
  /** Hook 2: let each plugin take events in (once the scheduler exists). */
  subscribe: (host: EventHost) => void;
  wakeStopped: (w: WakeStopped) => void;
  /** Hook 3: the notification kinds in effect (the core's, then each plugin's). */
  notificationKinds: NotificationKindInfo[];
}

export async function loadServerPlugins(
  configured: PluginSelection | undefined,
  host: Omit<ServerPluginHost, "options">,
): Promise<ServerPlugins> {
  const list: DaisyServerPlugin[] = [];
  for (const [name, options] of pluginSelection(configured)) {
    const mod = await importPlugin<ServerPluginModule>(name, "server");
    if (typeof mod.createServerPlugin !== "function")
      throw Error(ownerT()("server-plugins.noServerSide", { name }));
    const p = await mod.createServerPlugin({ ...host, options });
    if (!pluginNameMatches(name, p?.name))
      throw Error(ownerT()("server-plugins.wrongName", { name, got: String(p?.name).slice(0, 60) }));
    list.push(p);
  }
  const reader = list.find((p) => p.sessionPrompt?.readOrgCore)?.sessionPrompt
    ?.readOrgCore;
  const orgCore = list.find((p) => p.sessionPrompt?.orgCore)?.sessionPrompt
    ?.orgCore;
  // Hook 3: checked plugin by plugin, so a bad declaration names its plugin.
  let kinds = notificationKinds([], ownerT());
  for (const p of list)
    try {
      const own = p.notificationKinds ?? [];
      if (!Array.isArray(own)) throw Error(ownerT()("server-plugins.kindsNotList"));
      kinds = notificationKinds([...kinds.slice(NOTIFICATION_KINDS.length), ...own], ownerT());
    } catch (e: any) {
      throw Error(ownerT()("server-plugins.pluginError", { name: p.name, why: e.message }));
    }
  const jobs = list.flatMap((p) => (p.events?.jobs ? [p.events.jobs] : []));
  if (jobs.length) bookkeeping.set(host.store, jobs);
  else bookkeeping.delete(host.store);
  return {
    names: list.map((p) => p.name),
    notificationKinds: kinds,
    ...(orgCore ? { orgCore: { ...orgCore } } : {}),
    ...(reader ? { readOrgCore: reader } : {}),
    subscribe: (h) => {
      for (const p of list) p.events?.subscribe(h);
    },
    wakeStopped: (w) => {
      for (const p of list) p.events?.wakeStopped?.(w);
    },
  };
}

/** Hook 2's job bookkeeping, per store (one app's plugins; tests run several apps). */
const bookkeeping = new WeakMap<Store, JobBookkeeping[]>();

/** What the enabled plugins filed against queued wake jobs (none: no-ops). */
export function pluginJobs(store: Store): JobBookkeeping {
  const list = () => bookkeeping.get(store) ?? [];
  return {
    keys: (jobId) => list().flatMap((b) => b.keys(jobId)),
    move: (from, into, keys) => {
      for (const b of list()) b.move(from, into, keys);
    },
    kept: (jobId) => list().some((b) => b.kept(jobId)),
  };
}
