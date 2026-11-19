/**
 * P4-02 tests: probe routes for the 「放别人进来」 kinds phase 4 / 5 will
 * add (an allowlist route of its own) —
 * defined as those packages will
 * define theirs (P4-01's contacts, P4-03's requests / grants / ranges,
 * P4-06's public agent and P4-07's resident agents are real routes now,
 * api/contacts.ts, api/invoke.ts and api/residents.ts, and P4-12's
 * `daisy token`, api/tokens.ts, P5-03's pairing, api/devices.ts, and
 * P5-02's relay, api/relay.ts — no probe):
 * `letsIn` and `daisy:grant`, no `pin`
 * (the table puts it on). tests/let-in.test.ts (T-8) and the
 * every-route × every-caller matrix (tests/access.test.ts) serve them.
 */
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { serve } from "../../packages/daisy/src/app/serve.ts";
import { commitLetIn } from "../../packages/daisy/src/access/let-in-commit.ts";
import type { AnyRoute } from "../../packages/contracts/src/index.ts";
import { exempt, group, json, route } from "../../packages/contracts/src/api/route.ts";

/**
 * Probe routes: what an allowlist route of its own
 * will add, defined as they will be — `letsIn` and `daisy:grant`, nothing
 * else (no `pin`: the table puts it on).
 */
const probes = group("grant", {
  allowlistAdd: route({
    method: "POST",
    path: "/api/allowlist",
   
    scope: "daisy:grant",
    letsIn: "invoke-grant",
    output: json<{ ok: true }>("{ ok: true }"),
    cli: exempt(),
  }),
});
// P5-02 / P5-03: the relay and pairing are real routes now — no settings probe left.
const settingsProbes: Record<string, AnyRoute> = {};
export { probes, settingsProbes };
export const PROBES: AnyRoute[] = [...Object.values(probes), ...Object.values(settingsProbes)];

/** Register the probes on an app (before its first request). */
export function serveProbes(app: FastifyInstance) {
  for (const p of PROBES) serve(app, p, async (req) => commitLetIn(req, () => ({ ok: true, probe: p.id })));
}
