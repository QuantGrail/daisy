/**
 * P1-03 (ADR-110): the routes of packages/contracts/src/api/access.ts and
 * GET /api/me. Who may call each is decided by the guard from the
 * definitions; these handlers only do the work.
 */
import { callerT } from "../a2a/errors.ts";
import { ownerT } from "../platform/language.ts";
import type { FastifyInstance } from "fastify";
import { api } from "../../../contracts/src/api/index.ts";
import type { AccessStatus } from "../../../contracts/src/api/access.ts";
import { serve } from "../app/serve.ts";
import { LocalizedError } from "../app/errors.ts";
import type { Store } from "../store/index.ts";
import type { Access } from "./index.ts";
import { faceOf, rateIdOf, validateExternal } from "./faces.ts";
import { ownerUser } from "./owner.ts";
import { writeAccessConfig, type ExternalConfig } from "./config.ts";
import type { Principal } from "./guard.ts";
import { normalizeUiOrigins } from "./ui-origins.ts";
import { commitLetIn } from "./let-in-commit.ts";
import { linkFields, outsideLink } from "./outside-link.ts";
import { TlsRefused } from "./tls.ts";
import { log } from "../observe/log.ts";

export function registerAccessRoutes(
  app: FastifyInstance,
  store: Store,
  a: Access,
): void {
  const A = api.access;
  const who = (req: any): Principal => {
    const p = req.daisyPrincipal as Principal | undefined;
    if (!p) throw new LocalizedError(401, "unauthenticated", "server-access.unauthenticated");
    return p;
  };
  const status = (): AccessStatus => {
    const c = a.config();
    return {
      local: {
        url: a.faces.local.url,
        port: a.faces.local.port,
        portSource: a.faces.local.source,
      },
      external: {
        enabled: c.external.enabled,
        listening: a.faces.externalListening,
        url: a.faces.external.url,
        host: c.external.host,
        port: a.faces.external.port ?? c.external.port ?? null,
        tls: c.external.tls,
        fingerprint: a.faces.externalListening && a.faces.external.tls ? a.faces.external.fingerprint : null,
        allow: c.external.allow,
      },
      passcode: {
        mode: c.passcode,
        effective: a.passcodeOn(),
        sharedHost: a.sharedHost(),
      },
    };
  };

  serve(app, api.system.me, async (req) => {
    const p = who(req);
    return { ...ownerUser(), channel: p.channel, face: p.face, ...(p.deviceId ? { deviceId: p.deviceId } : {}) };
  });

  serve(
    app,
    A.webSession,
    async (req) => {
      const face = faceOf(req);
      const b = A.webSession.body.parse(req.body ?? {});
      let viaCode = false;
      if (b.code) {
        if (!a.web.takeCode(b.code, face)) {
          a.guard.audit("anonymous", face, "web", "settings.webSession", "code_invalid");
          (req as any).daisyAudited = true; // P1-11: this row is the request's
          throw new LocalizedError(401, "code_invalid", "server-access.web.codeInvalid");
        }
        viaCode = true;
      } else if (
        face !== "local" ||
        a.passcodeOn() ||
        // A page of this face asking (not a script without an Origin)…
        req.headers.origin === undefined ||
        // …from a process of the owner's own system account (review H-1:
        // an Origin header can be forged; another account — a service
        // account the shared-host check does not count — cannot pass
        // this; access/peer.ts, fails closed).
        !a.peerIsOwner(req)
      ) {
        a.guard.audit("anonymous", face, "web", "settings.webSession", "passcode_required");
        (req as any).daisyAudited = true;
        throw new LocalizedError(
          401,
          "passcode_required",
          face === "local" ? "server-access.web.passcodeLocal" : "server-access.web.passcodeRemote",
        );
      }
      const s = a.web.open(face, viaCode);
      store.audit("web", "web.session.open", JSON.stringify({ face, channel: "web", viaCode }));
      return { ...s, face };
    },
    {
      config: {
        // Review L-7: a code and a code-less ask are counted apart, so
        // failed code-less asks (a script, another account) never use up
        // the owner's budget for the link `daisy open` printed. Requests
        // the guard refused (another site, another Host) never get here.
        rateLimit: {
          max: 20,
          timeWindow: "1 minute",
          // After the body is read, so the key can tell a code from none.
          hook: "preHandler",
          keyGenerator: (req: any) =>
            // P5-02 review M-1: per face; a relay caller by the relay's word.
            `${rateIdOf(req)}:${req.body && typeof req.body === "object" && (req.body as any).code ? "code" : "nocode"}`,
        },
      },
    },
  );

  serve(app, A.webLogout, async (req) => {
    const p = who(req);
    if (p.webSession) a.web.close(p.webSession);
    return { ok: true as const };
  });

  const linkFor = (base: string | null, code: string) => {
    if (!base) throw new LocalizedError(409, "face_down", "server-access.web.faceDown");
    return `${base}/#code=${encodeURIComponent(code)}`;
  };
  const actor = (req: any) => req.daisyPrincipal?.label ?? "anonymous";
  const where = (req: any, extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      face: req.daisyPrincipal?.face ?? faceOf(req),
      channel: req.daisyPrincipal?.channel ?? "none",
      ...extra,
    });
  serve(app, A.openCode, async (req) => {
    const c = a.web.issueCode("local");
    store.audit(actor(req), "web.code", where(req, { for: "local" }));
    // In-process requests (tests) have no listening port: a link to it anyway.
    return { ...c, url: linkFor(a.faces.local.url ?? "http://127.0.0.1", c.code) };
  });
  serve(app, A.openCodeExternal, async (req) => {
    // P5-03b: reachable from elsewhere — the listener, or a relay (its fixed address first).
    const link = outsideLink(a.faces, a.relayAddress(), "code", callerT(req));
    if (!link) throw new LocalizedError(409, "external_off", "server-access.web.noOutside");
    const c = commitLetIn(req, () => a.web.issueCode("external"));
    store.audit(actor(req), "web.code", where(req, { for: "external", via: link.main.via }));
    return { ...c, ...linkFields(link, "code", c.code) };
  });

  serve(app, A.show, async () => status());

  serve(app, A.externalOn, async (req) => {
    const b = A.externalOn.body.parse(req.body);
    const host = b.host.trim().replace(/^\[(.*)\]$/, "$1");
    const bad = validateExternal({ host, tls: b.tls });
    if (bad) throw LocalizedError.of(400, "external_invalid", bad);
    const c: ExternalConfig = {
      enabled: true,
      host,
      ...(b.port ? { port: b.port } : {}),
      tls: b.tls,
      allow: b.allow,
    };
    try {
      await a.faces.startExternal(c);
    } catch (e: any) {
      // Review L5: the answer says what kind of failure (paths and uids only in the log).
      if (e instanceof TlsRefused) {
        log.warn(`✗ ${e.message}`);
        throw new LocalizedError(409, "tls_refused", "server-access.external.failed", { why: e.reason });
      }
      if (e?.code === "EADDRINUSE") throw new LocalizedError(409, "port_in_use", "server-access.external.failed", { why: String(e.message) });
      if (e?.code === "EADDRNOTAVAIL") throw new LocalizedError(409, "external_invalid", "server-access.external.noAddress", { host });
      log.warn(`✗ outside face could not be turned on: ${e?.message || e}`);
      throw new LocalizedError(409, "external_failed", "server-access.external.failedSeeLog", { code: e?.code ?? ownerT()("server-access.external.unknownError") });
    }
    // Review M-1: saved only under the PIN the grant passed with; else the
    // listener just started goes again (a reset meanwhile turned it off).
    try {
      commitLetIn(req, () => {
        writeAccessConfig(a.dataDir, (old) => ({ ...old, external: c }));
        // D-09: listening beyond this machine turns the passcode on — the
        // local sessions made without a code stop counting (guard.ts).
        a.web.drop("local", true);
      });
    } catch (e) {
      await a.faces.stopExternal();
      throw e;
    }
    store.audit(actor(req), "access.external.on", where(req, { host, tls: b.tls, allow: b.allow }));
    return status();
  });

  serve(app, A.externalOff, async (req) => {
    const c = a.config().external;
    await a.faces.setExternal({ ...c, enabled: false });
    a.web.drop("external");
    // P5-03: the unused pairing codes were for the outside face.
    a.devices.clearCodes();
    store.audit(actor(req), "access.external.off", where(req));
    return status();
  });

  serve(app, A.passcode, async (req) => {
    const b = A.passcode.body.parse(req.body);
    commitLetIn(req, () => {
      writeAccessConfig(a.dataDir, (c) => ({ ...c, passcode: b.mode }));
      if (a.passcodeOn()) a.web.drop("local", true);
    });
    store.audit(actor(req), "access.passcode", where(req, { mode: b.mode }));
    return status();
  });

  // P2-04 (ADR-115): browser origins of external interfaces.
  serve(app, A.uiOriginsShow, async () => ({ origins: [...a.uiOrigins.get()] }));

  serve(app, A.uiOriginsSet, async (req) => {
    const b = A.uiOriginsSet.body.parse(req.body);
    const r = normalizeUiOrigins(b.origins);
    if ("error" in r) throw LocalizedError.of(400, "ui_origin_invalid", r.error);
    const before = [...a.uiOrigins.get()];
    commitLetIn(req, () => a.uiOrigins.set(r.origins));
    store.audit(actor(req), "access.ui_origins.set", where(req, { origins: r.origins, before }));
    return { origins: r.origins };
  });

  serve(app, A.uiOriginsClear, async (req) => {
    const before = [...a.uiOrigins.get()];
    a.uiOrigins.set([]);
    store.audit(actor(req), "access.ui_origins.clear", where(req, { before }));
    return { origins: [] };
  });
}
