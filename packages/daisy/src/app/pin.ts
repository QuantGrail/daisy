import type { FastifyInstance } from "fastify";
import { api } from "../../../contracts/src/api/index.ts";
import {
  PIN_VIA,
  type PinVia,
} from "../../../contracts/src/index.ts";
import { holderOf as principalHolder, type Principal } from "../access/guard.ts";
import { PinError } from "../access/pin.ts";
import { LocalizedError } from "./errors.ts";
import { serve } from "./serve.ts";
import type { AppContext } from "./context.ts";
/**
 * P1-05: the PIN's routes (packages/contracts/src/api/pin.ts). Who: the
 * owner, through the channel and face the guard (P1-03, access/guard.ts)
 * allowed from the definitions — `pinReset` is the command line on this
 * machine only (`channels: ["cli"]`; the command line's credential is
 * valid on the local face only). The audit names the action and the entry
 * (`pin@<via>`), never the PIN or a grant (S-1).
 */
export function registerPinRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { store, pin, user: admin } = ctx;
  const P = api.pin;
  const target = (via: PinVia) => `pin@${via}`;
  /** Refusals worth the owner's attention are audited too. */
  const auditRefusal = (uid: string, action: string, via: PinVia, e: unknown) => {
    if (!(e instanceof PinError)) return;
    if (e.code === "pin_wrong") store.audit(uid, `${action}.wrong`, target(via));
    if (e.justLocked) store.audit(uid, "pin.locked", target(via));
    if (e.code === "pin_verifier_unreadable")
      store.audit(uid, "pin.unreadable", target(via));
  };
  serve(app, P.pinStatus, async (req) => {
    admin(req);
    return pin.status();
  });
  serve(app, P.pinSet, async (req) => {
    const u = admin(req),
      via = requestChannel(req);
    const b = P.pinSet.body.parse(req.body);
    const st = pin.status();
    const change = st.set;
    // P4-02 review H-1 (D-36): after a local reset, the first PIN is set on
    // this machine's command line only — not from a page or a token that
    // may belong to whoever caused the reset.
    const p = req.daisyPrincipal as Principal | undefined;
    if (!st.set && st.resetAt !== null && !(p?.channel === "cli" && p.face === "local")) {
      store.audit(u.id, "pin.set.refused", target(via));
      throw new LocalizedError(403, "pin_set_local_only", "server-app.pin.setLocalOnly");
    }
    try {
      pin.set(b.pin, b.oldPin, via);
    } catch (e) {
      auditRefusal(u.id, "pin.change", via, e);
      throw e;
    }
    store.audit(u.id, change ? "pin.change" : "pin.set", target(via));
    return { ok: true };
  });
  serve(app, P.pinGrant, async (req, reply) => {
    const u = admin(req),
      via = requestChannel(req);
    const b = P.pinGrant.body.parse(req.body);
    try {
      const g = pin.grant(b.pin, holderOf(req));
      store.audit(u.id, "pin.grant", target(via));
      reply.header("Cache-Control", "no-store");
      return g;
    } catch (e) {
      auditRefusal(u.id, "pin.grant", via, e);
      throw e;
    }
  });
  serve(app, P.pinReset, async (req) => {
    const u = admin(req);
    P.pinReset.body.parse(req.body);
    try {
      pin.resetLocal("cli");
    } catch (e) {
      // Review L-1: outside hooks that already ran are not undone with the
      // transaction — recorded here, after its rollback.
      const f = ctx.access.revocations.failure();
      if (f?.outsideDone.length)
        store.audit(u.id, "pin.reset.partial", JSON.stringify(f));
      throw e;
    }
    store.audit(u.id, "pin.reset", target("cli"));
    return { ok: true };
  });
}

/**
 * The credential a request came with — what a PIN grant is bound to
 * (local-api.md §6.3): P1-03's `holderOf(principal)` — `web:<the web
 * session's SHA-256>`, or `cli` (whose grant is used up at once).
 */
export function holderOf(req: any): string {
  const p = req?.daisyPrincipal as Principal | undefined;
  if (!p) throw new LocalizedError(401, "unauthenticated", "server-app.auth.noCredential");
  return principalHolder(p);
}

/** Which entry a request came through (the guard's principal), for the audit and the D-36 notice. */
export function requestChannel(req: any): PinVia {
  const c = req?.daisyPrincipal?.channel;
  return (PIN_VIA as readonly string[]).includes(c) ? (c as PinVia) : "unknown";
}
