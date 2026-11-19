import type { DaisyClient } from "@daisy-ai/client";
import type { Snapshot } from "@daisy-ai/contracts";
import { onHostConventions } from "./host-conventions";

/**
 * Last view of each AI conversation this page has shown or prefetched (chat
 * latency work, 2026-10-30): reopening one paints at once from here, marked
 * unconfirmed (「正在同步…」) while the conversation fetches only
 * what changed since its cursor. Memory only, a few, per client instance (a
 * new login is a new client: nothing carries over) and emptied by
 * `clearSessionCache()` (logout; also on the host's `window` logout
 * event — host-conventions.ts — and in the other tabs of this browser).
 */
const MAX = 40;
/** Newest items a conversation opens with (DaisyChat first shows the last few turns). */
export const SESSION_TAIL = 120;
interface Entry {
  snap: Snapshot;
  /** When the server answered with it. */
  at: number;
}
let snapshots = new WeakMap<DaisyClient, Map<string, Entry>>();
let inflight = new WeakMap<DaisyClient, Map<string, Promise<void>>>();
function dropMemory() {
  snapshots = new WeakMap();
  inflight = new WeakMap();
}
let channel: { postMessage(m: unknown): void } | null = null;
/** Logout: forget every kept conversation view here and in other tabs. */
export function clearSessionCache() {
  dropMemory();
  try {
    channel?.postMessage("clear");
  } catch {
    /* closed channel */
  }
}
if (
  typeof window !== "undefined" &&
  typeof window.addEventListener === "function"
) {
  let logoutEvent = "";
  const onLogout = () => clearSessionCache();
  onHostConventions((c) => {
    if (c.logoutEvent === logoutEvent) return;
    if (logoutEvent) window.removeEventListener(logoutEvent, onLogout);
    logoutEvent = c.logoutEvent;
    window.addEventListener(logoutEvent, onLogout);
  });
  try {
    if (typeof BroadcastChannel !== "undefined") {
      const bc = new BroadcastChannel("daisy-session-cache");
      bc.onmessage = (e) => e.data === "clear" && dropMemory();
      // Node (tests): never keeps the process alive.
      (bc as any).unref?.();
      channel = bc;
    }
  } catch {
    /* no BroadcastChannel: this tab only */
  }
}
const of = <T>(m: WeakMap<DaisyClient, Map<string, T>>, c: DaisyClient) => {
  let x = m.get(c);
  if (!x) m.set(c, (x = new Map()));
  return x;
};

export function cachedSnapshot(client: DaisyClient, sid: string) {
  return snapshots.get(client)?.get(sid)?.snap || null;
}
/** When the server last confirmed the cached view (0 = none cached). */
export function cachedAt(client: DaisyClient, sid: string) {
  return snapshots.get(client)?.get(sid)?.at || 0;
}
export function rememberSnapshot(
  client: DaisyClient,
  s: Snapshot,
  at = Date.now(),
  /** The server's log went back (restore): replace whatever is kept. */
  reset = false,
) {
  const all = of(snapshots, client),
    k = s.session.id;
  const old = all.get(k)?.snap;
  // An older version never replaces a newer one; at the same version the
  // wider window stays.
  if (
    !reset &&
    old &&
    (old.cursor > s.cursor ||
      (old.cursor === s.cursor && old.items.length > s.items.length))
  )
    return;
  all.delete(k);
  all.set(k, { snap: s, at });
  while (all.size > MAX) all.delete(all.keys().next().value!);
}
/** The prefetch of this conversation still in flight, if any (opening waits for it instead of asking twice). */
export function inflightSnapshot(client: DaisyClient, sid: string) {
  return inflight.get(client)?.get(sid);
}
/**
 * Fetch a conversation ahead of opening it (hover, idle; once at a time):
 * the newest items only; opening it then asks for what changed since.
 */
export function prefetchSnapshot(client: DaisyClient, sid: string) {
  const pending = of(inflight, client);
  if (cachedSnapshot(client, sid) || pending.has(sid)) return pending.get(sid);
  const p = client
    .snapshot(sid, { tail: SESSION_TAIL })
    .then((s) => rememberSnapshot(client, s))
    .catch(() => {})
    .finally(() => pending.delete(sid));
  pending.set(sid, p);
  return p;
}
