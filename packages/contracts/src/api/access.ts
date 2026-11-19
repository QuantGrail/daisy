/**
 * P1-03 (ADR-110): how the owner gets in — the web page's session (a
 * one-time code from `daisy open`, or none on this machine with the
 * passcode off), the outside face (D-31, ADR-101) and the passcode
 * (D-09, 5.12). packages/daisy/src/access/routes.ts.
 */
import { z } from "zod";
import { cmd, exempt, group, json, route, secretInput } from "./route.ts";

/** Who reaches the web page, and how (GET /api/access). */
export interface AccessStatus {
  local: {
    url: string | null;
    port: number | null;
    /** derived (from the uid), remembered, given (explicit), moved (taken, a free one used). */
    portSource: "derived" | "remembered" | "given" | "moved" | null;
  };
  external: {
    enabled: boolean;
    listening: boolean;
    url: string | null;
    host: string;
    port: number | null;
    tls: boolean;
    /**
     * P6-15 (ADR-158): SHA-256 of the self-signed certificate the listener
     * serves (DER, colon hex — what openssl and the browser show); compare
     * it with the browser's before going on. Null: not listening or plain HTTP.
     */
    fingerprint: string | null;
    /** Off on the outside face until turned on (with the PIN). */
    allow: { terminal: boolean; shell: boolean; browse: boolean };
  };
  passcode: {
    mode: "auto" | "on" | "off";
    /** What applies now: on when set on, when the outside face is on, or (auto) on a shared machine. */
    effective: boolean;
    /** auto's reading of this machine: other people's accounts on it. */
    sharedHost: boolean;
  };
}

const faceUrl = z.object({
  code: z.string(),
  url: z.string(),
  expiresAt: z.number(),
});
/**
 * P5-03b: the outside face's link — the direct listener's first, the
 * relay's as the alternative; no link (the code by hand) for a relay with
 * only a self-signed certificate (see PairingCode in devices.ts).
 */
const externalFaceUrl = faceUrl.extend({
  url: z.string().nullable(),
  via: z.enum(["relay", "direct"]),
  certificate: z.enum(["trusted", "custom-ca", "self-signed", "plain"]),
  warning: z.string().nullable(),
  /** P6-15: the direct link's self-signed certificate SHA-256 (colon hex); null otherwise. */
  fingerprint: z.string().nullable(),
  relayUrl: z.string().nullable(),
  relayCertificate: z.enum(["trusted", "custom-ca", "self-signed"]).nullable(),
  relayWarning: z.string().nullable(),
});

export const ExternalFaceSchema = z
  .object({
    host: z
      .string()
      .min(1)
      .max(253)
      .describe("api.field.access.host"),
    port: z
      .number()
      .int()
      .min(1024)
      .max(65535)
      .optional()
      .describe("api.field.access.port"),
    tls: z
      .boolean()
      .default(true)
      .describe("api.field.access.tls"),
    allow: z
      .object({
        terminal: z.boolean().default(false),
        shell: z.boolean().default(false),
        browse: z.boolean().default(false),
      })
      .default({ terminal: false, shell: false, browse: false })
      .describe("api.field.access.allow"),
  })
  .strict();

/**
 * P2-04 (ADR-115): the origins of external interfaces running in a browser
 * that may call this Daisy (CORS). Only the external issuer's token for
 * the owner is accepted from them; a server-side interface (no `Origin`)
 * needs nothing here.
 */
export const UiOriginsSchema = z
  .object({
    origins: z
      .array(z.string().min(1).max(300))
      .max(16)
      .describe(
        "api.field.access.origins",
      ),
  })
  .strict();

/** GET / PUT / DELETE /api/access/ui-origins. */
export interface UiOriginsStatus {
  /** The browser origins whose requests carry CORS answers (normalized). */
  origins: string[];
}

export const access = group("settings", {
  webSession: route({
    method: "POST",
    path: "/api/web/session",
    scope: null,
    notLetIn: true,
    auth: "one-time-code",
    body: z
      .object({
        code: secretInput(z.string().min(16).max(200)).optional(),
      })
      .strict(),
    output: json<{ token: string; expiresAt: number; face: "local" | "external" }>(
      "{ token, expiresAt, face }",
    ),
    errors: ["passcode_required", "code_invalid"],
    cli: exempt(),
  }),
  webLogout: route({
    method: "DELETE",
    path: "/api/web/session",
    scope: "daisy:session:read",
    notLetIn: true,
    channels: ["web", "device"],
    output: json<{ ok: true }>("{ ok: true }"),
    cli: exempt(),
  }),
  openCode: route({
    method: "POST",
    path: "/api/web/open-code",
    scope: "daisy:manage",
    notLetIn: true,
    output: json(faceUrl, "{ code, url, expiresAt }"),
    errors: ["face_down"],
    cli: exempt(),
  }),
  openCodeExternal: route({
    method: "POST",
    path: "/api/web/open-code/external",
    scope: "daisy:grant",
    pin: true,
    letsIn: "face",
    output: json(externalFaceUrl, "{ code, url, expiresAt, via, certificate, warning, fingerprint, relayUrl, relayCertificate, relayWarning }"),
    errors: ["external_off", "pin_required"],
    cli: exempt(),
  }),
  show: route({
    method: "GET",
    path: "/api/access",
    scope: "daisy:manage",
    output: json<AccessStatus>("AccessStatus"),
    cli: cmd("access show"),
  }),
  externalOn: route({
    method: "PUT",
    path: "/api/access/external",
    scope: "daisy:grant",
    pin: true,
    letsIn: "face",
    body: ExternalFaceSchema,
    output: json<AccessStatus>("AccessStatus"),
    errors: ["pin_required", "external_invalid", "port_in_use", "tls_refused", "external_failed"],
    cli: cmd("access external on"),
  }),
  externalOff: route({
    method: "DELETE",
    path: "/api/access/external",
    scope: "daisy:manage",
    notLetIn: true,
    output: json<AccessStatus>("AccessStatus"),
    cli: cmd("access external off"),
  }),
  passcode: route({
    method: "PUT",
    path: "/api/access/passcode",
    scope: "daisy:grant",
    pin: true,
    letsIn: "face",
    body: z.object({ mode: z.enum(["auto", "on", "off"]) }).strict(),
    output: json<AccessStatus>("AccessStatus"),
    errors: ["pin_required"],
    cli: cmd("access passcode", { args: ["mode"] }),
  }),
  uiOriginsShow: route({
    method: "GET",
    path: "/api/access/ui-origins",
    scope: "daisy:manage",
    output: json<UiOriginsStatus>("UiOriginsStatus"),
    cli: cmd("access ui-origins show"),
  }),
  uiOriginsSet: route({
    method: "PUT",
    path: "/api/access/ui-origins",
    scope: "daisy:grant",
    pin: true,
    letsIn: "ui-origin",
    body: UiOriginsSchema,
    output: json<UiOriginsStatus>("UiOriginsStatus"),
    errors: ["pin_required", "ui_origin_invalid"],
    cli: cmd("access ui-origins set"),
  }),
  uiOriginsClear: route({
    method: "DELETE",
    path: "/api/access/ui-origins",
    scope: "daisy:manage",
    notLetIn: true,
    output: json<UiOriginsStatus>("UiOriginsStatus"),
    cli: cmd("access ui-origins clear"),
  }),
});
