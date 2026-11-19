/**
 * P5-02 (总纲 5.9, 7.6 P5-02, 5.10 「设置」, 5.11 「选择中转」, D-05, D-41,
 * ADR-100, ADR-101, ADR-143, ADR-144): this Daisy's relay — pick one
 * (`daisy relay set`, PIN: it lets the world reach the outside face),
 * turn it off (narrows; still the PIN, 5.10), see whether it is connected and which
 * certificate the relay address has. packages/daisy/src/relay/routes.ts.
 *
 * And the TLS binding claim (ADR-100, a2a-usage.md §15.1): public, no
 * token — another Daisy reads it before it sends any token.
 */
import { z } from "zod";
import { binary, cmd, exempt, group, json, route } from "./route.ts";

/** GET /api/relay. */
export interface RelayStatus {
  enabled: boolean;
  /** The relay's own address (`https://relay.example[:port]`), as set. */
  relay: string | null;
  /** off · connecting · connected · waiting (backing off before the next try) · refused (the operator does not admit this Daisy: no more tries). */
  state: "off" | "connecting" | "connected" | "waiting" | "refused";
  /** Since when in this state (ms). */
  since: number | null;
  /** The fixed address callers use (`https://<32 characters>.<relay domain>[:port]`): in the identity card and the agent cards. */
  address: string | null;
  /** The last connection problem (no secrets), and when the next try is. */
  lastError: string | null;
  retryAt: number | null;
  /** Streams through the relay right now. */
  streams: number;
  cert: {
    /** acme: a CA's (ACME TLS-ALPN-01); self-signed: the fallback (Daisy-to-Daisy only); none: not made yet. */
    kind: "acme" | "self-signed" | "none";
    notAfter: number | null;
    /** When it is renewed / ACME tried again (ARI's window when the CA has one). */
    renewAt: number | null;
    /** ACME on (default) and its directory. */
    acme: { enabled: boolean; directory: string };
    /** Why ACME did not give a certificate (the last try). */
    lastError: string | null;
    /** One sentence for people: what works through this relay with this certificate. */
    note: string;
  };
}

/** The relay address field's description: a pack key (P6-23a). */
export const RELAY_ADDRESS_HINT = "api.field.relay.address";

export const RelaySetSchema = z
  .object({
    url: z.string().min(1).max(300).describe(RELAY_ADDRESS_HINT),
    acme: z
      .boolean()
      .default(true)
      .describe("api.field.relay.acme"),
    acmeDirectory: z
      .string()
      .min(1)
      .max(300)
      .optional()
      .describe("api.field.relay.acmeDirectory"),
  })
  .strict();

export const relay = group("settings", {
  relayShow: route({
    method: "GET",
    path: "/api/relay",
    scope: "daisy:manage",
    output: json<RelayStatus>("RelayStatus"),
    cli: cmd("relay show"),
  }),
  relaySet: route({
    method: "PUT",
    path: "/api/relay",
    scope: "daisy:grant",
    pin: true,
    letsIn: "relay",
    body: RelaySetSchema,
    output: json<RelayStatus>("RelayStatus"),
    errors: ["pin_required", "relay_invalid"],
    cli: cmd("relay set", { args: ["url"] }),
  }),
  relayOff: route({
    method: "DELETE",
    path: "/api/relay",
    scope: "daisy:grant",
    pin: true,
    notLetIn: true,
    output: json<RelayStatus>("RelayStatus"),
    errors: ["pin_required"],
    cli: cmd("relay off"),
  }),
});

export const tlsBinding = group("system", {
  tlsBinding: route({
    method: "GET",
    path: "/.well-known/daisy-tls-binding",
    scope: null,
    // Not an operation of the owner's (no channel): another Daisy's client reads it.
    channels: [],
    output: binary("api.output.jwsCompact"),
    errors: ["not_found"],
    cli: exempt(),
  }),
});
