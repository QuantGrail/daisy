/**
 * P5-02 (ADR-144): the routes of packages/contracts/src/api/relay.ts. Who
 * may call each is the guard's (definitions): choosing a relay is
 * `letsIn: "relay"` (daisy:grant + PIN, never the AI's credential);
 * turning it off narrows but still takes the PIN (5.10: the AI must not
 * quietly cut the owner off); the binding claim is public.
 */
import type { FastifyInstance } from "fastify";
import { api } from "../../../contracts/src/api/index.ts";
import { serve } from "../app/serve.ts";
import { LocalizedError } from "../app/errors.ts";
import type { Store } from "../store/index.ts";
import { faceOf } from "../access/faces.ts";
import { commitLetIn } from "../access/let-in-commit.ts";
import type { Access } from "../access/index.ts";
import { checkAcmeDirectory, DEFAULT_ACME_DIRECTORY, parseRelayUrl } from "./config.ts";
import type { Relay } from "./index.ts";

export function registerRelayRoutes(app: FastifyInstance, store: Store, a: Access, relay: Relay): void {
  const R = api.relay;
  const actor = (req: any) => req.daisyPrincipal?.label ?? "anonymous";
  const where = (req: any, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ face: req.daisyPrincipal?.face ?? faceOf(req), channel: req.daisyPrincipal?.channel ?? "none", ...extra });

  serve(app, R.relayShow, async () => relay.status());

  serve(app, R.relaySet, async (req) => {
    const b = R.relaySet.body.parse(req.body ?? {});
    const p = parseRelayUrl(b.url);
    if ("error" in p) throw LocalizedError.of(400, "relay_invalid", p.error);
    const directory = b.acmeDirectory ?? DEFAULT_ACME_DIRECTORY;
    const bad = checkAcmeDirectory(directory);
    if (bad) throw LocalizedError.of(400, "relay_invalid", bad);
    const c = { enabled: true, url: p.url, acme: { enabled: b.acme, directory } };
    const before = relay.address();
    // Saved only under the PIN the grant passed with (ADR-121 §4a); D-09:
    // reachable from elsewhere now — local sessions made without a code stop counting.
    commitLetIn(req, () => {
      relay.save(c);
      a.web.drop("local", true);
      // P5-03b review L-3: another relay address — what was handed out for
      // the old one goes, as when the relay is turned off: the unused
      // pairing codes, the outside face's sessions and one-time codes.
      if (before && before !== relay.address()) {
        a.web.drop("external");
        a.devices.clearCodes();
      }
    });
    await relay.apply();
    store.audit(actor(req), "relay.set", where(req, { relay: p.url, acme: b.acme, directory }));
    return relay.status();
  });

  serve(app, R.relayOff, async (req) => {
    const was = relay.config();
    // Saved off only under the PIN the grant passed with (ADR-121 §4a); then disconnected.
    commitLetIn(req, () => {
      relay.save({ ...was, enabled: false });
      // Review L-3: the outside face's web sessions end, as when the outside face goes off.
      a.web.drop("external");
      // P5-03b: the unused pairing codes go too (their link was the relay's), as when the outside face goes off.
      a.devices.clearCodes();
    });
    await relay.halt();
    store.audit(actor(req), "relay.off", where(req, { relay: was.url || null }));
    return relay.status();
  });

  serve(app, api.tlsBinding.tlsBinding, async (_req, reply) => {
    const text = await relay.bindingClaim();
    if (!text) throw new LocalizedError(404, "not_found", "server-relay.binding.noKey");
    reply.header("cache-control", "no-store");
    return reply.type("application/jwt").send(text);
  });
}
