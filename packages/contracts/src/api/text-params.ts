/**
 * P6-23a (ADR-159 §7): the numbers the route table's text quotes — a
 * limit in a route's description or a field's — filled into the packs'
 * `{name}`s when the text is shown (`routeText`, `describedText`), so a
 * limit changed in limits.ts changes the docs and the help with it.
 */
import { DEVICE_LIMITS, EVENT_LIMITS, PIN_LIMITS } from "../limits.ts";

export const API_TEXT_PARAMS: Readonly<Record<string, number>> = {
  devicePairCodeMinutes: DEVICE_LIMITS.pairCodeTtlMs / 60_000,
  devicePendingCodesMax: DEVICE_LIMITS.pendingCodesMax,
  deviceRedeemFailuresMax: DEVICE_LIMITS.redeemFailuresMax,
  deviceRedeemLockMinutes: DEVICE_LIMITS.redeemLockMs / 60_000,
  deviceCodeWrongMax: DEVICE_LIMITS.codeWrongMax,
  deviceRedeemPerMinute: DEVICE_LIMITS.redeemPerMinute,
  deviceSessionHours: DEVICE_LIMITS.sessionTtlMs / 3_600_000,
  deviceIdleDays: DEVICE_LIMITS.idleExpiryMs / 86_400_000,
  deviceSessionPerMinute: DEVICE_LIMITS.sessionPerMinute,
  deviceNameMax: DEVICE_LIMITS.nameMax,
  eventsPageMax: EVENT_LIMITS.pageMax,
  eventsWaitMaxS: EVENT_LIMITS.waitMaxS,
  eventsRetentionDays: EVENT_LIMITS.retentionMs / 86_400_000,
  pinMinLength: PIN_LIMITS.minLength,
  pinMaxLength: PIN_LIMITS.maxLength,
  pinGrantMinutes: PIN_LIMITS.grantTtlMs / 60_000,
  pinAttemptsPerRound: PIN_LIMITS.attemptsPerRound,
};
