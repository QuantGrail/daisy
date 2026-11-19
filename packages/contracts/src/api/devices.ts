/**
 * P5-03 (总纲 7.6 「配对」, 5.11 「配对新设备、吊销设备」, D-08, W-3,
 * ADR-142): the owner's other devices — a phone's browser, first.
 *
 * - `daisy pair` (or 设置 › 设备) makes a pairing code: the PIN, short-lived
 *   (DEVICE_LIMITS.pairCodeTtlMs), good once, for the outside face. It
 *   lets another device in as the owner: `letsIn: "device"`.
 * - The other device (the outside face's web page) trades the code for a
 *   device credential (`ddev_…`, kept on the device, never shown again) and
 *   a first device session (`dweb_…`, ≤ DEVICE_LIMITS.sessionTtlMs — the
 *   Bearer on every request, channel `device`). When a session runs out the
 *   page trades the device credential for a new one.
 * - The owner lists the devices and revokes any one (PIN): at once — its
 *   sessions go, its live sockets close, a request in flight is answered
 *   401. A PIN reset revokes every device (`devices`, T-9).
 *
 * packages/daisy/src/access/devices.ts, device-routes.ts.
 */
import { z } from "zod";
import { DEVICE_LIMITS } from "../limits.ts";
import { cmd, exempt, group, json, route, secretInput, PIN_ON_CLI } from "./route.ts";

/** One paired device, as its record keeps it (never its credential). */
export interface Device {
  /** `dev_…` */
  id: string;
  name: string;
  /** The face it was paired on and may be used on (the outside face; P5-02's relay enters there too). */
  face: "local" | "external";
  createdAt: number;
  /** Who made the pairing code (`web`, `cli`, `device:<id>`, `issuer`). */
  createdBy: string;
  /** The last time it traded its credential for a session (or was seen with one); null: never. */
  lastUsedAt: number | null;
  /**
   * The address it last came from: as the direct listener saw it, or —
   * through the relay — what the relay reported for the caller (null when
   * it reported nothing; never this machine's own end of the relay stream).
   */
  lastIp: string | null;
  /** P5-03b: the way it last came in — the direct listener, or through the relay; null: never. */
  lastVia: "direct" | "relay" | null;
  /** The browser it said it was, when paired (cut short). */
  userAgent: string | null;
  state: "active" | "expired" | "revoked";
  revokedAt: number | null;
  /** owner: revoked from the list; self: the device unpaired itself; pin_reset: the PIN was reset. */
  revokedWhy: "owner" | "self" | "pin_reset" | null;
  /** This request came from this very device. */
  current: boolean;
}

/** What `POST /api/devices/pair` answers: show the code, or the link (a QR of it). */
export interface PairingCode {
  /** `XXXXX-XXXXX` (Crockford base32, 50 random bits). Shown once; never logged. */
  code: string;
  /**
   * The outside face's page with the code after `#pair=` (never in a
   * request line). P5-03b review M-1: the direct listener's when it is on
   * (a relay operator can have a certificate for the relay address made,
   * ADR-100 / D-41 ②); the relay's fixed address only when it is the one
   * way in. Review L-1: null — no link, no QR, the code typed by hand —
   * when that way is a relay with only a self-signed certificate.
   */
  url: string | null;
  /** Which way `url` (or, when it is null, the code) goes. */
  via: "relay" | "direct";
  /**
   * What a phone's browser makes of that way's certificate: `trusted` — a
   * Let's Encrypt certificate (the relay address only); `custom-ca` — a CA
   * the owner named (the phone must trust it); `self-signed` — it warns
   * (the relay's fallback, the listener's own TLS); `plain` — plain HTTP
   * (a private network only).
   */
  certificate: "trusted" | "custom-ca" | "self-signed" | "plain";
  /** Plain words about `url` (the relay operator; the certificate; not connected), or null. */
  warning: string | null;
  /** P6-15 (ADR-158): SHA-256 of the direct link's self-signed certificate (DER, colon hex), to compare with the browser's; null otherwise. */
  fingerprint: string | null;
  /** Review M-1: the relay's link as the alternative when `url` is the direct one; null when there is none to give (no relay, or only self-signed). */
  relayUrl: string | null;
  /** The relay's certificate, when a relay is on and `url` is the direct link (else null). */
  relayCertificate: "trusted" | "custom-ca" | "self-signed" | null;
  /** Plain words about the relay alternative (the operator; self-signed: why there is no link). */
  relayWarning: string | null;
  expiresAt: number;
  /** The name the owner gave (the device may propose its own when none). */
  name: string | null;
  /**
   * Review L-2: some source was locked (wrong codes typed) when this code
   * was made, and how many wrong codes came in the last lock window.
   * 设置 › 设备 says so. P5-03b review L-2: the locks stay — each pauses
   * only its own source, never this code for the others.
   */
  wasLocked: boolean;
  recentFailures: number;
}

/** Review L-2 (P5-03b): a source whose wrong pairing codes paused pairing from it. */
export interface PairLock {
  /** `external:ip:<addr>` (the direct listener), `relay:<addr>` (the relay's word for the caller). */
  who: string;
  until: number;
}

/** What the device gets for the code (`redeem`) or its credential (`session`). */
export interface DeviceSession {
  deviceId: string;
  /** A device session (`dweb_…`): the Bearer for every request, valid on `face` only. */
  token: string;
  expiresAt: number;
  face: "local" | "external";
}

export const DeviceNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(DEVICE_LIMITS.nameMax)
  .describe("api.field.devices.deviceName");

export const PairBodySchema = z
  .object({
    name: DeviceNameSchema.optional().describe("api.field.devices.name"),
  })
  .strict();

export const PairRedeemSchema = z
  .object({
    code: secretInput(z.string().min(8).max(40)).describe("api.field.devices.code"),
    name: DeviceNameSchema.optional().describe("api.field.devices.name2"),
  })
  .strict();

export const DeviceSessionSchema = z
  .object({
    secret: secretInput(z.string().min(16).max(200)).describe("api.field.devices.secret"),
  })
  .strict();

export const devices = group("settings", {
  pair: route({
    method: "POST",
    path: "/api/devices/pair",
    scope: "daisy:grant",
    letsIn: "device",
    body: PairBodySchema,
    output: json<PairingCode>("PairingCode"),
    errors: ["pin_required", "external_off", "too_many_devices"],
    cli: cmd("pair"),
  }),
  pairRedeem: route({
    method: "POST",
    path: "/api/devices/redeem",
    scope: null,
    auth: "pairing-code",
    notLetIn: true,
    body: PairRedeemSchema,
    output: json<DeviceSession & { secret: string; name: string }>("DeviceSession & { secret, name }"),
    errors: ["code_invalid", "pair_locked", "device_face", "too_many_devices"],
    cli: exempt(),
  }),
  deviceSession: route({
    method: "POST",
    path: "/api/devices/session",
    scope: null,
    auth: "device-secret",
    notLetIn: true,
    body: DeviceSessionSchema,
    output: json<DeviceSession>("DeviceSession"),
    errors: ["device_invalid", "device_face"],
    cli: exempt(),
  }),
  deviceList: route({
    method: "GET",
    path: "/api/devices",
    scope: "daisy:grant",
    ...PIN_ON_CLI,
    query: z
      .object({
        state: z.enum(["active", "all"]).default("active").describe("api.route.settings.deviceList.field.state"),
      })
      .strict(),
    output: json<{ devices: Device[]; pairLockedUntil: number | null; pairLocks: PairLock[] }>("{ devices: Device[], pairLockedUntil, pairLocks }"),
    cli: cmd("device list"),
  }),
  deviceRevoke: route({
    method: "DELETE",
    path: "/api/devices/:id",
    scope: "daisy:grant",
    letsIn: "device",
    params: z.object({ id: z.string().min(1).max(64).describe("api.route.settings.deviceRevoke.field.id") }).strict(),
    output: json<{ revoked: Device }>("{ revoked: Device }"),
    errors: ["pin_required", "device_not_found"],
    cli: cmd("device revoke"),
  }),
  deviceForget: route({
    method: "DELETE",
    path: "/api/devices/self",
    scope: "daisy:session:read",
    channels: ["device"],
    notLetIn: true,
    output: json<{ revoked: Device }>("{ revoked: Device }"),
    cli: exempt(),
  }),
});
