import { setInterval, clearInterval } from "node:timers";
import type { FastifyInstance } from "fastify";
import type { User } from "../../../contracts/src/index.ts";
import { normalizeNodeCapabilities } from "../../../contracts/src/agent-capabilities.ts";
import { LocalizedError } from "./errors.ts";
import type { AppBase, AppContext, LateServices } from "./context.ts";
import type { QueueCore } from "./queue.ts";
import { log } from "../observe/log.ts";
import { nodeAutoUpdate } from "../update/package.ts";
import { namedFor } from "../platform/default-names.ts";
import type { Translate } from "../../../contracts/src/i18n.ts";
/**
 * This machine's Runner (P1-00: moved from app.ts). P1-02: the Runner runs
 * in this process; P1-03: no machine management — no owners, no
 * revocation, no enrolment. One Daisy has one Runner, the `nodes` row the
 * first start made; the node id stays on workspaces, identities and jobs
 * as that Runner's name.
 */
export function nodeAccess(ctx: AppBase & LateServices & QueueCore) {
  const { opts, store } = ctx;
  /** When each node's runner was last heard from by this instance. */
  const heard = new Map<string, number>();
  const presenceMs = opts.presenceMs ?? 10_000;
  /** A row of a Runner that is still there (a row revoked before P1-03 is not). */
  function canUseNode(_u: User, n: any) {
    return !!n && !n.revoked_at;
  }
  function usableNode(_u: User, nid: string) {
    const n = store.one("SELECT * FROM nodes WHERE id=?", nid);
    if (!n) throw new LocalizedError(404, "node_not_found", "server-app.node.notFound");
    if (n.revoked_at) throw new LocalizedError(409, "node_revoked", "server-app.node.revoked");
    return n;
  }
  /** A node row as the UI sees it (P6-28: a default name in `t`'s language). */
  function nodeView(n: any, t?: Translate) {
    // ADR-152: a row a Runner before the rename wrote says `"harbor"`.
    const capabilities = normalizeNodeCapabilities(JSON.parse(n.capabilities));
    // P6-15 (ADR-158, P5N-2): the auto-update a node shows is this
    // process's updater as it is now — the Runner's last sync (every few
    // seconds, longer while it is busy) lags behind `daisy update --source`.
    // One Daisy, one Runner, in this process (P1-02): its row is the one
    // whose capabilities say how it updates.
    const p = ctx.packageUpdate;
    const runner = (capabilities as any)?.runner;
    if (p && runner && typeof runner === "object" && runner.autoUpdate)
      (capabilities as any).runner = { ...runner, autoUpdate: nodeAutoUpdate(p.status()) };
    return {
      id: n.id,
      ...namedFor("node", n.label, t),
      lastSeen: n.last_seen,
      capabilities,
      online: Date.now() - n.last_seen < 30_000,
    };
  }
  /**
   * The node a Runner call is for (P1-02: named by the in-process port,
   * RunnerPort.connect — no token, no network check: nothing outside this
   * process can make the call).
   */
  function node(req: any) {
    const n =
      typeof req.nodeId === "string"
        ? store.one("SELECT * FROM nodes WHERE id=?", req.nodeId)
        : null;
    if (!n || n.revoked_at) throw new LocalizedError(401, "node_unknown", "server-app.node.unknown");
    heard.set(n.id, Date.now());
    return n;
  }
  /** P1-03: no runner-user check any more (one owner, one system account). */
  const claimingNode = node;
  /** Nodes that should send their live report now, via /claim. */
  const liveNudge = new Set<string>();
  /** The conversation's device as its owner sees it (「所在设备离线」). */
  const presence = (nodeId: string, t?: Translate) => {
    const n = store.one(
      "SELECT label,last_seen,revoked_at FROM nodes WHERE id=?",
      nodeId,
    );
    if (!n) return { online: false, lastSeen: 0, label: "" };
    // Heard from this server instance: every runner request counts (it asks
    // for work about every half second). Otherwise (just restarted) the
    // heartbeat rule of the node list.
    const at = heard.get(nodeId);
    return {
      online:
        !n.revoked_at &&
        (at !== undefined
          ? Date.now() - at < presenceMs
          : Date.now() - n.last_seen < 30_000),
      lastSeen: Math.max(n.last_seen || 0, at || 0),
      ...namedFor("node", n.label, t),
    };
  };
  return {
    heard,
    presenceMs,
    liveNudge,
    canUseNode,
    usableNode,
    nodeView,
    claimingNode,
    node,
    presence,
  };
}
export type NodeAccess = ReturnType<typeof nodeAccess>;
/** The presence sweep (P1-00: moved from app.ts). */
export function startPresenceSweep(
  app: FastifyInstance,
  ctx: AppContext,
): void {
  const { store, peers, presence, presenceMs, touched } = ctx;
  // A device going quiet or coming back changes no event: tell the open
  // views of its conversations (a `touched` frame) when it flips.
  const toldOnline = new Map<string, boolean>();
  const presenceSweep = setInterval(
    () => {
      try {
        const watched = new Set([...peers.values()].map((p) => p.sid));
        for (const sid of toldOnline.keys())
          if (!watched.has(sid)) toldOnline.delete(sid);
        const byNode = new Map<string, boolean>();
        for (const sid of watched) {
          const s = store.session(sid);
          if (!s) continue;
          let online = byNode.get(s.nodeId);
          if (online === undefined)
            byNode.set(s.nodeId, (online = presence(s.nodeId).online));
          const before = toldOnline.get(sid);
          toldOnline.set(sid, online);
          if (before !== undefined && before !== online) touched(sid);
        }
      } catch (e) {
        log.error("[presence]", (e as Error)?.message || e);
      }
    },
    Math.min(2000, Math.max(50, presenceMs / 4)),
  );
  (presenceSweep as unknown as NodeJS.Timeout).unref();
  app.addHook("onClose", async () => clearInterval(presenceSweep));
}
