/**
 * P5-03 (ADR-142): the routes of packages/contracts/src/api/devices.ts.
 * Who may call each is the guard's (definitions); these handlers only do
 * the work — and keep the face rule (a device is paired and used on the
 * outside face only) and the audit.
 *
 * - pair: `letsIn: "device"` — the code is stored inside `commitLetIn`.
 * - redeem / session: public, authenticated by the pairing code / device
 *   credential; limited per address. Never a code or credential in the
 *   audit (S-1): only the device's id, name and face.
 * - revoke: `letsIn: "device"`, inside `commitLetIn`; forget (the device
 *   itself): no PIN, narrowing only.
 */
import { callerT } from "../a2a/errors.ts";
import type { FastifyInstance } from "fastify";
import { api } from "../../../contracts/src/api/index.ts";
import { DEVICE_LIMITS } from "../../../contracts/src/limits.ts";
import { serve } from "../app/serve.ts";
import { LocalizedError } from "../app/errors.ts";
import type { Store } from "../store/index.ts";
import type { Access } from "./index.ts";
import { callerOf, faceOf, rateIdOf } from "./faces.ts";
import { linkFields, outsideLink } from "./outside-link.ts";
import type { Principal } from "./guard.ts";
import { commitLetIn } from "./let-in-commit.ts";
import { DeviceError } from "./devices.ts";

export function registerDeviceRoutes(app: FastifyInstance, store: Store, a: Access): void {
  const D = api.devices;
  const who = (req: any) => req.daisyPrincipal as Principal | undefined;
  const actor = (req: any) => who(req)?.label ?? "anonymous";
  const http = (e: unknown) => {
    if (!(e instanceof DeviceError)) return e;
    const h = new LocalizedError(e.status, e.code, e.key, e.params);
    if (e.retryAfter) (h as any).retryAfter = e.retryAfter;
    return h;
  };
  const where = (req: any, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ face: who(req)?.face ?? faceOf(req), channel: who(req)?.channel ?? "none", ...extra });

  serve(app, D.pair, async (req) => {
    const b = D.pair.body.parse(req.body ?? {});
    // The code is good on the outside face only: useless while nothing
    // reaches it from elsewhere (P5-03b: the listener, or a relay).
    const link = outsideLink(a.faces, a.relayAddress(), "pair", callerT(req));
    if (!link)
      throw new LocalizedError(409, "external_off", "server-access.device.pairNoOutside");
    let c;
    try {
      c = commitLetIn(req, () => a.devices.issueCode(b.name, actor(req)));
    } catch (e) {
      throw http(e);
    }
    store.audit(actor(req), "device.pair.code", where(req, { name: c.name, expiresAt: c.expiresAt, wasLocked: c.wasLocked, recentFailures: c.recentFailures, via: link.main.via }));
    return { ...c, ...linkFields(link, "pair", c.code) };
  });

  serve(
    app,
    D.pairRedeem,
    async (req: any) => {
      const face = faceOf(req);
      const b = D.pairRedeem.body.parse(req.body ?? {});
      try {
        const r = a.devices.redeem(b.code, {
          face,
          ...(b.name ? { name: b.name } : {}),
          userAgent: String(req.headers["user-agent"] ?? ""),
          // P5-03b: through the relay, the relay's word (never this machine's end of its stream).
          ip: callerOf(req) ?? undefined,
          // Review L-2: wrong codes lock this source only (the rate-limit bucket: per face, a relay caller by the relay's word).
          bucket: rateIdOf(req),
        });
        store.audit(`device:${r.device.id}`, "device.paired", JSON.stringify({ face, channel: "device", device: r.device.id, name: r.device.name, by: r.device.createdBy }), {
          channel: "device",
          object: r.device.id,
        });
        req.daisyAudited = true;
        return { ...r.session, secret: r.secret, name: r.device.name };
      } catch (e) {
        if (e instanceof DeviceError) {
          a.guard.audit("anonymous", face, "device", "settings.pairRedeem", e.code);
          req.daisyAudited = true;
        }
        throw http(e);
      }
    },
    {
      config: {
        rateLimit: {
          max: DEVICE_LIMITS.redeemPerMinute,
          timeWindow: "1 minute",
          // P5-02 review M-1: per face, a relay caller by the relay's word.
          keyGenerator: (req: any) => `pair:${rateIdOf(req)}`,
        },
      },
    },
  );

  serve(
    app,
    D.deviceSession,
    async (req: any) => {
      const face = faceOf(req);
      const b = D.deviceSession.body.parse(req.body ?? {});
      try {
        const s = a.devices.exchange(b.secret, { face, ip: callerOf(req) ?? undefined });
        store.audit(`device:${s.deviceId}`, "device.session.open", JSON.stringify({ face, channel: "device", device: s.deviceId }), {
          channel: "device",
          object: s.deviceId,
        });
        req.daisyAudited = true;
        return s;
      } catch (e) {
        if (e instanceof DeviceError) {
          a.guard.audit("anonymous", face, "device", "settings.deviceSession", e.code);
          req.daisyAudited = true;
        }
        throw http(e);
      }
    },
    {
      config: {
        rateLimit: {
          max: DEVICE_LIMITS.sessionPerMinute,
          timeWindow: "1 minute",
          keyGenerator: (req: any) => `device-session:${rateIdOf(req)}`,
        },
      },
    },
  );

  serve(app, D.deviceList, async (req: any) => {
    const q = D.deviceList.query.parse(req.query ?? {});
    return { devices: a.devices.list(q.state, who(req)?.deviceId), pairLockedUntil: a.devices.lockedUntilAt(), pairLocks: a.devices.pairLocks() };
  });

  serve(app, D.deviceRevoke, async (req: any) => {
    const id = String(req.params.id);
    const p = who(req);
    let revoked;
    try {
      revoked = commitLetIn(req, () => a.devices.revoke(id, "owner", actor(req), p?.deviceId));
    } catch (e) {
      throw http(e);
    }
    // A device that revoked itself (with the PIN) still gets this answer.
    if (p?.deviceId === id) req.daisyDeviceSelfRevoked = true;
    store.audit(actor(req), "device.revoke", where(req, { device: id, name: revoked.name }), { object: id });
    return { revoked };
  });

  serve(app, D.deviceForget, async (req: any) => {
    const p = who(req);
    if (!p?.deviceId) throw new LocalizedError(403, "channel_not_allowed", "server-access.device.forgetNotDevice");
    const revoked = a.devices.revoke(p.deviceId, "self", actor(req), p.deviceId);
    req.daisyDeviceSelfRevoked = true;
    store.audit(actor(req), "device.forget", where(req, { device: p.deviceId }), { object: p.deviceId });
    return { revoked };
  });
}
