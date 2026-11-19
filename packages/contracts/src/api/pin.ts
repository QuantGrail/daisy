/**
 * P1-05: the PIN (5.11 「PIN 码」, D-11, D-32; local-api.md §6). The
 * server side is packages/daisy/src/access/pin.ts. Wiring the PIN in front of
 * the 「放别人进来」 routes is stage 4 (P4-02); the local-only check of
 * `pin.reset` is P1-03's.
 */
import { z } from "zod";
import { cmd, exempt, group, json, route, secretInput } from "./route.ts";
import { PIN_LIMITS } from "../limits.ts";

/** The request header that carries a PIN grant (local-api.md §2, §6). */
export const PIN_GRANT_HEADER = "daisy-pin-grant";

/**
 * A PIN as compared: Unicode NFKC, so the web page and a terminal agree
 * and full-width digits (１２３４５６) are the ASCII ones.
 */
export const normalizePin = (pin: string) => pin.normalize("NFKC");

/**
 * Why `pin` cannot be a PIN (D-32), or null when it can: 6 to 128
 * characters (counted as Unicode code points after NFKC), no control
 * characters. Digits only is allowed. P6-23a: the answer is a pack key
 * (its params: `PIN_RULE_PARAMS`), said in the reader's language.
 */
export function pinRuleError(pin: string): "api.pin.rule.length" | "api.pin.rule.control" | null {
  const p = normalizePin(pin);
  const n = [...p].length;
  if (n < PIN_LIMITS.minLength || n > PIN_LIMITS.maxLength) return "api.pin.rule.length";
  if (/\p{Cc}/u.test(p)) return "api.pin.rule.control";
  return null;
}
/** The params of `pinRuleError`'s keys. */
export const PIN_RULE_PARAMS = { min: PIN_LIMITS.minLength, max: PIN_LIMITS.maxLength } as const;

// The schemas only bound the size; the rule itself is the server's
// (pinRuleError), so its answer says what is wrong in words.
const pinField = (key: string) =>
  secretInput(z.string().min(1).max(PIN_LIMITS.maxLength * 4).describe(key));

/**
 * Through which entry the PIN was set or reset (D-36: the owner is told,
 * on the web page and paired devices, when and how): an owner channel
 * (token.md §3), `local` — a call inside this process on this machine,
 * `unknown` — before P1-03 the local API cannot tell its channels apart.
 */
export const PIN_VIA = ["web", "device", "cli", "issuer", "local", "unknown"] as const;
export type PinVia = (typeof PIN_VIA)[number];

export const PinStatusSchema = z.object({
  set: z.boolean().describe("api.field.pin.set"),
  lockedUntil: z
    .number()
    .nullable()
    .describe("api.field.pin.lockedUntil"),
  setAt: z.number().nullable().describe("api.field.pin.setAt"),
  setVia: z.enum(PIN_VIA).nullable().describe("api.field.pin.setVia"),
  resetAt: z.number().nullable().describe("api.field.pin.resetAt"),
  resetVia: z.enum(PIN_VIA).nullable().describe("api.field.pin.resetVia"),
});
export type PinStatus = z.output<typeof PinStatusSchema>;

export const PinSetBodySchema = z
  .object({
    pin: pinField("api.field.pin.newPin"),
    oldPin: pinField("api.field.pin.oldPin").optional(),
  })
  .strict();

export const PinGrantBodySchema = z.object({ pin: pinField("api.field.pin.pin") }).strict();

export const PinGrantSchema = z.object({
  grant: z.string().describe("api.field.pin.grant"),
  expiresAt: z.number().describe("api.field.pin.expiresAt"),
});

export const pin = group("settings", {
  pinStatus: route({
    method: "GET",
    path: "/api/pin",
    scope: "daisy:manage",
    output: json(PinStatusSchema, "PinStatus"),
    cli: cmd("pin status"),
  }),
  pinSet: route({
    method: "POST",
    path: "/api/pin",
    scope: "daisy:manage",
    notLetIn: true,
    body: PinSetBodySchema,
    output: json<{ ok: true }>("{ ok: true }"),
    errors: [
      "pin_invalid",
      "pin_old_required",
      "pin_wrong",
      "pin_locked",
      "pin_verifier_unreadable",
      "pin_set_local_only",
    ],
    cli: cmd("pin set"),
  }),
  pinGrant: route({
    method: "POST",
    path: "/api/pin/grant",
    scope: "daisy:grant",
    notLetIn: true,
    body: PinGrantBodySchema,
    output: json(PinGrantSchema, "{ grant, expiresAt }"),
    errors: ["pin_not_set", "pin_wrong", "pin_locked", "pin_verifier_unreadable"],
    cli: exempt(),
  }),
  pinReset: route({
    method: "POST",
    path: "/api/pin/reset",
    scope: "daisy:grant",
    notLetIn: true,
    channels: ["cli"],
    body: z
      .object({
        confirm: z
          .literal(true)
          .describe("api.route.settings.pinReset.field.confirm"),
      })
      .strict(),
    output: json<{ ok: true }>("{ ok: true }"),
    errors: ["channel_not_allowed"],
    cli: cmd("pin reset"),
  }),
});
