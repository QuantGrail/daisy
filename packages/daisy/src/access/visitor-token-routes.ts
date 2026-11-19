/**
 * P4-12 (ADR-132): the routes of packages/contracts/src/api/tokens.ts —
 * `daisy token issue / list / revoke`. All `daisy:grant` on the owner's
 * channels (never the AI, never a visitor); issuing and revoking are
 * `letsIn: "visitor-token"` (PIN); listing takes the PIN on the command line only (D-40 ①).
 *
 * P4-02 review M-1 (ADR-121 §4a): the signature is made first (await),
 * then the record is written and the answer given inside `commitLetIn` —
 * a PIN reset meanwhile leaves no record (and a token without a record
 * verifies as nobody's).
 */
import type { FastifyInstance } from "fastify";
import { api } from "../../../contracts/src/api/index.ts";
import { serve } from "../app/serve.ts";
import { HttpError, LocalizedError } from "../app/errors.ts";
import { callerT } from "../a2a/errors.ts";
import type { Principal } from "./guard.ts";
import { commitLetIn } from "./let-in-commit.ts";
import { visitorTokenWarning, VisitorTokenError, type VisitorTokens } from "./visitor-tokens.ts";

export function registerVisitorTokenRoutes(app: FastifyInstance, tokens: VisitorTokens): void {
  const T = api.tokens;
  const actor = (req: any) => (req.daisyPrincipal as Principal | undefined)?.label ?? "anonymous";
  const http = (e: unknown) =>
    e instanceof VisitorTokenError
      ? typeof e.text === "string"
        ? new HttpError(e.status, e.text, e.code)
        : LocalizedError.of(e.status, e.code, e.text)
      : e;
  const run = <R>(req: any, fn: () => R): R => {
    try {
      return commitLetIn(req, fn);
    } catch (e) {
      throw http(e);
    }
  };

  serve(app, T.tokenIssue, async (req: any) => {
    const b = T.tokenIssue.body.parse(req.body ?? {});
    let signed;
    try {
      signed = await tokens.sign(b);
    } catch (e) {
      throw http(e);
    }
    return run(req, () => ({
      token: signed.token,
      record: tokens.commit(signed, b.note, actor(req)),
      warning: visitorTokenWarning(callerT(req)),
    }));
  });
  serve(app, T.tokenList, async (req: any) => {
    const q = T.tokenList.query.parse(req.query ?? {});
    try {
      return { tokens: tokens.list(q.state) };
    } catch (e) {
      throw http(e);
    }
  });
  serve(app, T.tokenRevoke, async (req: any) =>
    run(req, () => ({ revoked: tokens.revoke(String(req.params.jti), actor(req)) })),
  );
}
