/**
 * P2-02 (ADR-113): the route of packages/contracts/src/api/ai-token.ts.
 * The guard lets only the AI's working credential of a running turn of
 * this session through (`channels: []`, `aiSelf`), so the token is there
 * only while a turn runs; it goes to the MCP that asked, never into a log,
 * an error or the audit.
 */
import type { FastifyInstance } from "fastify";
import { api } from "../../../contracts/src/api/index.ts";
import { serve } from "../app/serve.ts";
import { LocalizedError } from "../app/errors.ts";
import type { Access } from "./index.ts";
import type { Principal } from "./guard.ts";
import { AiTokenError } from "./tokens/delegate.ts";

export function registerAiTokenRoutes(app: FastifyInstance, a: Access): void {
  serve(app, api.aiTokens.aiToken, async (req, reply) => {
    const p = req.daisyPrincipal as Principal | undefined;
    // The guard let only this session's running turn through (aiSelf).
    if (p?.kind !== "ai" || !p.sessionId) throw new LocalizedError(401, "unauthenticated", "server-access.unauthenticated");
    const b = api.aiTokens.aiToken.body.parse(req.body);
    try {
      const t = await a.delegated.get(p.sessionId, b.audience, b.scope);
      // The answer carries a token: never cached anywhere.
      reply.header("Cache-Control", "no-store");
      return t;
    } catch (e) {
      if (e instanceof AiTokenError) throw new LocalizedError(e.status, e.code, e.key, e.params);
      throw e;
    }
  });
}
