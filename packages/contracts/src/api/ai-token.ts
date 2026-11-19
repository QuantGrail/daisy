/**
 * P2-02 (token.md §6, X-4, ADR-113): a token fetched for the AI of a
 * running turn — from the external issuer by RFC 8693 token exchange, or
 * signed by this Daisy when there is none. Only the AI's working
 * credential reaches the route, so it works only while a turn runs
 * (README 待决 11, option A). packages/daisy/src/access/ai-token-routes.ts.
 */
import { z } from "zod";
import { exempt, group, json, route } from "./route.ts";

/** What the AI's MCP gets (P2-02). */
export interface AiToken {
  /** The token (Bearer). Never logged, never shown in a transcript. */
  token: string;
  tokenType: "Bearer";
  /** Seconds since the epoch. */
  expiresAt: number;
  audience: string;
  scope: string;
  /** Who signed it: the external issuer (RFC 8693 exchange) or this Daisy. */
  mode: "external" | "self";
}

export const AiTokenBodySchema = z
  .object({
    audience: z
      .string()
      .min(1)
      .max(512)
      .describe("api.field.ai-token.audience"),
    scope: z
      .string()
      .min(1)
      .max(1024)
      .regex(/^[\x21\x23-\x5B\x5D-\x7E]+( [\x21\x23-\x5B\x5D-\x7E]+)*$/, "api.validation.scopeList")
      .describe("api.field.ai-token.scope"),
  })
  .strict();

export const aiTokens = group("session", {
  aiToken: route({
    method: "POST",
    path: "/api/sessions/:id/ai-token",
    scope: "daisy:tools",
    notLetIn: true,
    channels: [],
    aiSelf: "id",
    body: AiTokenBodySchema,
    output: json<AiToken>("AiToken"),
    errors: ["ai_token_scope", "ai_token_audience", "ai_token_unavailable", "ai_token_rate_limited"],
    cli: exempt(),
  }),
});
