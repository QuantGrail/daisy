import { setTimeout, clearTimeout } from "node:timers";
import type { FastifyInstance } from "fastify";
import { RESTART_CLOSE } from "../update/lifecycle.ts";
import type { Event, User } from "../../../contracts/src/index.ts";
import { LIVE_CLOSE } from "../../../contracts/src/live.ts";
import type { AppBase, AppContext, LateServices } from "./context.ts";
import { serveSocket } from "./serve.ts";
import { ownerUser } from "../access/owner.ts";
import { faceOf } from "../access/faces.ts";
import { api } from "../../../contracts/src/api/index.ts";
import type { Principal } from "../access/guard.ts";
/**
 * A conversation's change signal (P1-00: moved from app.ts): its event
 * log and the live sockets watching it.
 */
export function eventBus(ctx: AppBase & LateServices) {
  const { store, access } = ctx;
  const peers = new Map<
    any,
    { user: User; sid: string; token: string; principal: Principal }
  >();
  const stillValid = (p: { token: string; principal: Principal }): boolean => {
    const pr = p.principal;
    if (pr.uiOrigin && !access.guard.uiOriginAllowed(pr.uiOrigin, pr.face)) return false;
    if (pr.channel !== "issuer")
      return !!access.guard.identifyOwner(p.token, pr.face);
    const x = access.issuer.get();
    return (
      pr.kind === "external-owner" &&
      !!x &&
      x.issuer === pr.issuer &&
      x.config.ownerSubject === pr.ownerSubject &&
      typeof pr.exp === "number" &&
      Math.floor(Date.now() / 1000) < pr.exp
    );
  };
  /**
   * P4-05: in-process watchers of every conversation's changes (an A2A
   * task waiting for its turn to start and end). Called after the sockets;
   * a watcher must not throw or block.
   */
  const watchers = new Set<(sid: string) => void>();
  const onSessionChange = (fn: (sid: string) => void) => {
    watchers.add(fn);
    return () => void watchers.delete(fn);
  };
  /** Tell a conversation's live sockets it changed at `cursor`. */
  const notify = (sid: string, cursor: number, touched = false) => {
    for (const w of watchers)
      try {
        w(sid);
      } catch {}
    for (const [socket, p] of peers) {
      // P1-03: a web session that ended (logout, expiry, the outside face
      // turned off, the passcode applied) ends its socket too. Review M-1:
      // an external issuer's token for the owner is checked against what it
      // was valid under — its expiry, the issuer, the owner subject (the
      // signature was checked when the socket subscribed). P2-04: and one
      // opened from an external interface's origin the owner since removed.
      if (!stillValid(p)) {
        socket.close(1008, "Login expired");
        continue;
      }
      if (p.sid === sid && socket.readyState === 1) {
        if (socket.bufferedAmount > 1024 * 1024) {
          socket.close(1013, "Client slow");
          continue;
        }
        socket.send(
          JSON.stringify({
            type: "changed",
            sessionId: sid,
            cursor,
            ...(touched ? { touched: true } : {}),
          }),
        );
      }
    }
  };
  /**
   * P5-03: close every live socket `pick` chooses now (a revoked device's)
   * — not at the next change: revoking is at once. P6-26 (P5N-6): with
   * its own code (`LIVE_CLOSE.deviceRevoked`) when it is a revocation, so
   * the page reacts on the close itself.
   */
  const closeSockets = (
    pick: (p: { principal: Principal }) => boolean,
    reason = "Login expired",
    code: number = LIVE_CLOSE.credential,
  ) => {
    for (const [socket, p] of peers)
      if (pick(p)) {
        peers.delete(socket);
        socket.close(code, reason);
      }
  };
  const broadcast = (ev: Event | null) => {
    if (ev) notify(ev.sessionId, ev.seq);
    return ev;
  };
  /**
   * The session record changed without an event (title, archive, settings):
   * the same signal at the current cursor, marked `touched`, so
   * open views fetch a (still empty) delta with the new session.
   */
  const touched = (sid: string) =>
    notify(
      sid,
      store.one(
        "SELECT COALESCE(MAX(seq),0) AS n FROM events WHERE session_id=?",
        sid,
      ).n,
      true,
    );
  const publish = (
    sid: string,
    type: Event["type"],
    data: any,
    eventId?: string,
  ) => broadcast(store.append(sid, type, data, eventId));
  return { peers, notify, broadcast, touched, publish, onSessionChange, closeSockets };
}
export type EventBus = ReturnType<typeof eventBus>;
/** /api/live: a conversation's changes (P1-00: moved from app.ts). */
export function registerLiveSocket(
  app: FastifyInstance,
  ctx: AppContext,
): void {
  const { store, lifecycle, peers, access } = ctx;
  serveSocket(app, api.system.live, (socket, req) => {
    // Being replaced: reconnect to the next process at once.
    if (lifecycle.draining) {
      socket.close(RESTART_CLOSE, "Server restart");
      return;
    }
    const timer = setTimeout(() => socket.close(1008, "Authenticate"), 5000);
    let expiry: ReturnType<typeof setTimeout> | undefined;
    // P1-03: the upgrade request already passed the guard's Host / Origin
    // checks; the first frame's credential gets the same identify /
    // authorize as a Bearer request (no AI credential: not in `channels`).
    socket.on("message", (raw) => {
      void (async () => {
        const b = JSON.parse(raw.toString());
        if (b.type === "subscribe") {
          const token = typeof b.token === "string" ? b.token : "";
          const p = token
            ? await access.guard.socketPrincipal(req, api.system.live, token)
            : null;
          const u = p ? ownerUser() : undefined,
            s = store.session(String(b.sessionId || ""));
          if (!p || !u || !s || s.ownerId !== u.id) {
            if (!p && !token)
              access.guard.audit("anonymous", faceOf(req), "none", "system.live", "unauthenticated");
            socket.close(1008, "Forbidden");
            return;
          }
          clearTimeout(timer);
          peers.set(socket, { user: u, sid: s.id, token, principal: p });
          // P2-04: an issuer token's socket ends when the token does (1008,
          // like a web session that ended): the interface asks its
          // credentials for a fresh one and subscribes again.
          clearTimeout(expiry);
          if (p.kind === "external-owner" && p.exp !== undefined) {
            expiry = setTimeout(
              () => socket.close(1008, "Login expired"),
              Math.max(0, Math.min(p.exp * 1000 - Date.now(), 2 ** 31 - 1)),
            );
          }
          // The session's cursor now: the view counts as live
          // once it holds at least this.
          socket.send(
            JSON.stringify({
              type: "ready",
              cursor: store.one(
                "SELECT COALESCE(MAX(seq),0) AS n FROM events WHERE session_id=?",
                s.id,
              ).n,
            }),
          );
        } else if (b.type === "ping")
          socket.send(JSON.stringify({ type: "pong" }));
      })().catch(() => socket.close(1008, "Bad frame"));
    });
    socket.on("close", () => {
      clearTimeout(timer);
      clearTimeout(expiry);
      peers.delete(socket);
    });
  });
}
