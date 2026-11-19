/**
 * P4-07 (ADR-126): the resident agents' routes (packages/contracts/src/api/
 * residents.ts). Creating, changing and resuming let others in — the
 * guard has asked for `daisy:grant` and the PIN; the write happens inside
 * `commitLetIn` (ADR-121 §4a), synchronously. Pausing, closing and
 * deleting only take away (no PIN); reading takes the PIN on the command line only (D-40 ①).
 */
import type { FastifyInstance } from "fastify";
import { api } from "../../../contracts/src/api/index.ts";
import { serve } from "../app/serve.ts";
import type { Principal } from "../access/guard.ts";
import { commitLetIn } from "../access/let-in-commit.ts";
import type { AppContext } from "../app/context.ts";
import type { ResidentAgents } from "./agents.ts";

export function registerResidentRoutes(app: FastifyInstance, ctx: AppContext, residents: ResidentAgents): void {
  const R = api.residents;
  const actor = (req: any) => (req.daisyPrincipal as Principal | undefined)?.label ?? "anonymous";
  // Reads: daisy:grant, the PIN on the command line only (D-40 ①); nothing is written.
  serve(app, R.residentList, async () => ({ residents: residents.list() }));
  serve(app, R.residentShow, async (req: any) => {
    const aid = String(req.params.aid);
    return { ...residents.view(aid), conversations: residents.conversations(aid) };
  });
  serve(app, R.residentCreate, async (req: any) => {
    const b = R.residentCreate.body.parse(req.body ?? {});
    const owner = ctx.user(req).id;
    return commitLetIn(req, () => residents.create(owner, b, actor(req)));
  });
  serve(app, R.residentSet, async (req: any) => {
    const b = R.residentSet.body.parse(req.body ?? {});
    return commitLetIn(req, () => residents.update(String(req.params.aid), b, actor(req)));
  });
  serve(app, R.residentResume, async (req: any) => commitLetIn(req, () => residents.resume(String(req.params.aid), actor(req))));
  serve(app, R.residentPause, async (req: any) => residents.pause(String(req.params.aid), actor(req)));
  serve(app, R.residentClose, async (req: any) => residents.close(String(req.params.aid), actor(req)));
  serve(app, R.residentDelete, async (req: any) => residents.remove(String(req.params.aid), actor(req)));
}
