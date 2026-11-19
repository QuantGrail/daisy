/**
 * P2-01 (ADR-113): the routes of packages/contracts/src/api/issuer.ts.
 * Who may call each is the guard's to decide, from the definitions:
 * configuring the issuer is `daisy:grant` + PIN on the owner's channels
 * (never the AI).
 */
import type { FastifyInstance } from "fastify";
import { api } from "../../../contracts/src/api/index.ts";
import type { IssuerStatus } from "../../../contracts/src/api/issuer.ts";
import { commitLetIn } from "./let-in-commit.ts";
import { serve } from "../app/serve.ts";
import { LocalizedError } from "../app/errors.ts";
import type { Store } from "../store/index.ts";
import type { Access } from "./index.ts";
import { faceOf } from "./faces.ts";
import type { Principal } from "./guard.ts";
import { ExternalIssuer, IssuerError, ownerTokenFile } from "./tokens/external-issuer.ts";
import { rmSync } from "node:fs";

export function registerIssuerRoutes(app: FastifyInstance, store: Store, a: Access): void {
  const I = api.issuer;
  const self = a.ai.self;
  const actor = (req: any) => (req.daisyPrincipal as Principal | undefined)?.label ?? "anonymous";
  const where = (req: any, extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      face: req.daisyPrincipal?.face ?? faceOf(req),
      channel: req.daisyPrincipal?.channel ?? "none",
      ...extra,
    });
  const httpOf = (e: unknown) =>
    e instanceof IssuerError
      ? new LocalizedError(e.code === "issuer_unreachable" ? 502 : 400, e.code, e.key, e.params)
      : e;

  async function status(): Promise<IssuerStatus> {
    const x = a.issuer.get();
    let ownerExp: number | null = null;
    const t = x?.ownerToken();
    if (x && t) {
      const v = await x.verify(t, { audience: x.config.audience });
      ownerExp = v.ok ? v.token.exp : null;
    }
    return {
      mode: x ? "external" : "self",
      self: { urn: self.urn, kid: self.kid, jwk: self.publicJwk },
      issuer: x ? x.status(ownerExp) : null,
    };
  }

  serve(app, I.issuerShow, async () => status());

  serve(app, I.issuerSet, async (req) => {
    const b = I.issuerSet.body.parse(req.body);
    let x: ExternalIssuer;
    try {
      x = await ExternalIssuer.configure(a.dataDir, b, { urn: self.urn }, a.httpIssuer);
    } catch (e) {
      throw httpOf(e);
    }
    if (b.ownerToken) {
      // The owner's own token: this issuer's, for this Daisy, the owner's
      // subject, not an AI's, still valid.
      const v = await x.verify(b.ownerToken, { audience: x.config.audience });
      if (!v.ok || v.token.subject !== x.config.ownerSubject || v.token.act)
        throw new LocalizedError(400, "owner_token_invalid", "server-access.issuer.ownerTokenInvalid");
    }
    // P4-02 review M-1: fetching the keys above took time; a PIN reset
    // meanwhile took the issuer back — it is not written back now.
    commitLetIn(req, () => {
      const before = a.issuer.get();
      x.save();
      if (b.ownerToken) x.storeOwnerToken(b.ownerToken!);
      // Another issuer, owner, audience or client (review L-4): the old
      // owner token is not for this configuration.
      else if (
        !before ||
        before.issuer !== x.issuer ||
        before.config.ownerSubject !== x.config.ownerSubject ||
        before.config.audience !== x.config.audience ||
        before.config.clientId !== x.config.clientId
      )
        rmSync(ownerTokenFile(a.dataDir), { force: true });
      a.issuer.set(x);
    });
    store.audit(
      actor(req),
      "access.issuer.set",
      where(req, {
        issuer: x.issuer,
        ownerSubject: x.config.ownerSubject,
        audience: x.config.audience,
        ownerToken: !!b.ownerToken,
      }),
    );
    return status();
  });

  serve(app, I.issuerRemove, async (req) => {
    const before = a.issuer.get();
    ExternalIssuer.remove(a.dataDir);
    a.issuer.set(null);
    store.audit(actor(req), "access.issuer.remove", where(req, { issuer: before?.issuer ?? null }));
    return status();
  });

  serve(app, I.issuerRefresh, async (req) => {
    const x = a.issuer.get();
    if (!x) throw new LocalizedError(409, "issuer_not_configured", "server-access.issuer.notConfigured");
    try {
      await x.refresh(true);
    } catch (e) {
      throw httpOf(e);
    }
    store.audit(actor(req), "access.issuer.refresh", where(req, { issuer: x.issuer }));
    return status();
  });
}
