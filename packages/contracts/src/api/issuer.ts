/**
 * P2-01 (token.md §4.2, 5.6, D-08): trusting an external issuer — its
 * address, which subject is this Daisy's owner, its public keys (JWKS,
 * cached in the data directory, verified offline). Configuring it lets
 * others in, so it takes `daisy:grant` and the PIN (5.11 「配置令牌签发方」);
 * the AI never may.
 *
 * packages/daisy/src/access/issuer-routes.ts.
 */
import { z } from "zod";
import { cmd, group, json, route, secretInput } from "./route.ts";

/** An issuer address: https, or http on this machine's loopback only. */
/** `key`: the field's description (it ends with the https rule). */
const issuerUrl = (key: string) =>
  z
    .string()
    .min(8)
    .max(2048)
    .describe(key);

export const IssuerSetSchema = z
  .object({
    issuer: issuerUrl("api.field.issuer.issuer"),
    metadataUrl: issuerUrl("api.field.issuer.metadataUrl")
      .optional(),
    jwksUri: issuerUrl("api.field.issuer.jwksUri").optional(),
    tokenEndpoint: issuerUrl("api.field.issuer.tokenEndpoint").optional(),
    ownerSubject: z
      .string()
      .min(1)
      .max(256)
      .describe("api.field.issuer.ownerSubject"),
    audience: z
      .string()
      .min(1)
      .max(512)
      .optional()
      .describe("api.field.issuer.audience"),
    clientId: z
      .string()
      .min(1)
      .max(512)
      .optional()
      .describe("api.field.issuer.clientId"),
    ownerToken: secretInput(z.string().min(16).max(8192))
      .optional()
      .describe("api.field.issuer.ownerToken"),
  })
  .strict();

/** GET /api/access/issuer. Never a token. */
export interface IssuerStatus {
  /** `external` once an issuer is configured; `self` otherwise (this Daisy signs). */
  mode: "self" | "external";
  /** This Daisy's identity (its key's RFC 7638 thumbprint as a URN). */
  self: { urn: string; kid: string; jwk: { kty: string; crv: string; x: string } };
  issuer: null | {
    issuer: string;
    ownerSubject: string;
    audience: string;
    clientId: string;
    metadataUrl: string | null;
    jwksUri: string;
    tokenEndpoint: string | null;
    configuredAt: number;
    /** The cached public keys (their `kid`s and algorithms only). */
    keys: { kid: string; kty: string; alg: string | null }[];
    fetchedAt: number | null;
    /** When the cache is due for a refetch. */
    expiresAt: number | null;
    /** Past `expiresAt`: the cached keys are still used (原则 3) while a refetch is tried. */
    stale: boolean;
    /** Past `expiresAt` by more than limits.md's longest staleness (24 h): 已失效 — every token is refused until the issuer answers. */
    expired: boolean;
    /** A refetch is under way. */
    refreshing: boolean;
    lastError: string | null;
    /** Whether the owner's token for token exchange is stored, and until when it is valid. */
    ownerToken: { stored: boolean; expiresAt: number | null };
  };
}

export const issuer = group("settings", {
  issuerShow: route({
    method: "GET",
    path: "/api/access/issuer",
    scope: "daisy:manage",
    output: json<IssuerStatus>("IssuerStatus"),
    cli: cmd("access issuer show"),
  }),
  issuerSet: route({
    method: "PUT",
    path: "/api/access/issuer",
    scope: "daisy:grant",
    pin: true,
    letsIn: "issuer",
    body: IssuerSetSchema,
    output: json<IssuerStatus>("IssuerStatus"),
    errors: ["pin_required", "issuer_invalid", "issuer_unreachable", "owner_token_invalid"],
    cli: cmd("access issuer set"),
  }),
  issuerRemove: route({
    method: "DELETE",
    path: "/api/access/issuer",
    scope: "daisy:manage",
    notLetIn: true,
    output: json<IssuerStatus>("IssuerStatus"),
    cli: cmd("access issuer remove"),
  }),
  issuerRefresh: route({
    method: "POST",
    path: "/api/access/issuer/refresh",
    scope: "daisy:manage",
    notLetIn: true,
    output: json<IssuerStatus>("IssuerStatus"),
    errors: ["issuer_not_configured", "issuer_unreachable"],
    cli: cmd("access issuer refresh"),
  }),
});
