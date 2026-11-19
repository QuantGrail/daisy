/**
 * P4-03 (ADR-122): the routes of packages/contracts/src/api/invoke.ts. Who
 * may call each is the guard's to decide, from the definitions: all are
 * `daisy:grant` on the owner's channels (never the AI, never a visitor);
 * deciding, revoking and the range are `letsIn` (P4-02) and take the PIN.
 * Reads take the PIN on the command line only (D-40 ①); they persist nothing, so they answer outside `commitLetIn`.
 *
 * Every change is synchronous and answers inside `commitLetIn` (P4-02
 * review M-1, ADR-121 §4a): the PIN grant the guard checked is still the
 * one in force when the change is saved — or nothing is (409
 * `pin_changed`). Reads write nothing and answer directly (`read`).
 */
import type { FastifyInstance } from "fastify";
import { api } from "../../../contracts/src/api/index.ts";
import { serve } from "../app/serve.ts";
import { HttpError } from "../app/errors.ts";
import type { Principal } from "../access/guard.ts";
import { commitLetIn } from "../access/let-in-commit.ts";
import { ContactError } from "../contacts/index.ts";
import { InvokeError, type InvokeAccess } from "./invoke-access.ts";

export function registerInvokeRoutes(app: FastifyInstance, invoke: InvokeAccess): void {
  const I = api.invoke;
  const actor = (req: any) => (req.daisyPrincipal as Principal | undefined)?.label ?? "anonymous";
  /** The module's errors as HTTP answers. */
  const answer = <T>(fn: () => T): T => {
    try {
      return fn();
    } catch (e) {
      if (e instanceof InvokeError) throw e.toHttp();
      if (e instanceof ContactError)
        throw new HttpError(e.code === "contact_ambiguous" ? 409 : 404, e.message, e.code);
      throw e;
    }
  };
  /** A change: inside the PIN seal. */
  const run = <T>(req: any, fn: () => T): T => answer(() => commitLetIn(req, fn));
  /** A read (PIN on the command line only, D-40): nothing to persist, nothing to seal. */
  const read = <T>(fn: () => T): T => answer(fn);

  serve(app, I.requestList, async (req: any) => {
    const q = I.requestList.query.parse(req.query ?? {});
    return read(() => ({ requests: invoke.requests(q.status, q.limit) }));
  });
  serve(app, I.requestShow, async (req: any) => read(() => invoke.request(String(req.params.rid))));
  serve(app, I.requestDecide, async (req: any) => {
    const b = I.requestDecide.body.parse(req.body ?? {});
    return run(req, () => invoke.decide(String(req.params.rid), b.decision, actor(req), b.note));
  });

  serve(app, I.grantList, async (req: any) => {
    const q = I.grantList.query.parse(req.query ?? {});
    return read(() => ({ grants: invoke.grants(q) }));
  });
  serve(app, I.grantRevoke, async (req: any) => run(req, () => invoke.revokeGrant(String(req.params.gid), actor(req))));

  serve(app, I.audienceShow, async (req: any) => read(() => invoke.audience(String(req.params.aid))));
  serve(app, I.audienceSet, async (req: any) => {
    const b = I.audienceSet.body.parse(req.body ?? {});
    return run(req, () => invoke.setAudience(String(req.params.aid), b, actor(req)));
  });
}
