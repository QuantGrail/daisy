/**
 * P1-08: what the settings page and the banners say, as plain functions
 * (testable without React Native): the PIN's state and its history
 * (D-36), this Daisy's auto-update (D-34), the faces and the passcode.
 */
import type { PinStatusView } from "@daisy-ai/client";
import type { AccessStatus, NotificationItem } from "@daisy-ai/contracts";
import { t } from "./i18n";

/** Through which entry (P1-05 `setVia` / `resetVia`, PIN_VIA); `unknown` says nothing. */
export function viaLabel(via: string | null | undefined): string {
  switch (via) {
    case "web":
      return t("ui-settings.via.web");
    case "cli":
      return t("ui-settings.via.cli");
    case "device":
      return t("ui-settings.via.device");
    case "issuer":
      return t("ui-settings.via.issuer");
    case "local":
      return t("ui-settings.via.local");
    case "unknown":
    case "":
    case null:
    case undefined:
      return "";
  }
  return via;
}

/**
 * D-36: when and through which entry the PIN was set or reset — the
 * latest of the two first. Empty when P1-05 does not say (no fields).
 */
export function pinProvenance(
  st: PinStatusView | null | undefined,
  at: (ts: number) => string,
): string[] {
  if (!st) return [];
  const lines: { ts: number; text: string }[] = [];
  const line = (ts: unknown, via: unknown, what: "set" | "reset") => {
    if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0) return;
    const v = viaLabel(typeof via === "string" ? via : null);
    const text =
      what === "set"
        ? v
          ? t("ui-settings.pin.setVia", { at: at(ts), via: v })
          : t("ui-settings.pin.set", { at: at(ts) })
        : v
          ? t("ui-settings.pin.resetVia", { at: at(ts), via: v })
          : t("ui-settings.pin.reset", { at: at(ts) });
    lines.push({ ts, text });
  };
  line(st.setAt, st.setVia, "set");
  line(st.resetAt, st.resetVia, "reset");
  return lines.sort((a, b) => b.ts - a.ts).map((l) => l.text);
}

/** The banner over every page while no PIN is set (D-36), or null. */
export function pinBanner(
  st: PinStatusView | null | undefined,
): { title: string; detail: string } | null {
  if (!st || st.set) return null;
  return {
    title: t("ui-settings.pinBanner.title"),
    detail: st.resetAt ? t("ui-settings.pinBanner.reset") : t("ui-settings.pinBanner.unset"),
  };
}

/** What a PIN request's failure means to the owner. */
export function pinErrorText(e: { message?: string; code?: string }): string {
  switch (e.code) {
    case "pin_wrong":
      return t("ui-settings.pinError.wrong");
    case "pin_locked":
      return e.message || t("ui-settings.pinError.locked");
    case "pin_not_set":
      return t("ui-settings.pinError.notSet");
    case "route_not_defined":
      return t("ui-settings.pinError.unsupported");
  }
  return e.message || t("ui-settings.pinError.failed");
}

/**
 * This Daisy's auto-update (`capabilities.runner.autoUpdate`): the npm
 * update's (P5-06, ADR-145; update/package.ts `nodeAutoUpdate`).
 */
export interface AutoUpdate {
  state?: string;
  error?: string;
  reason?: string;
  target?: string;
  nextAt?: number;
}

/**
 * One line about this Daisy's auto-update (D-34: on by default; runner.json
 * `autoUpdate: false` turns it off). One process now: no remote devices, no
 * control plane to compare with.
 */
export function autoUpdateLine(au: AutoUpdate | null | undefined): {
  text: string;
  tone: "ok" | "wait" | "bad" | "muted";
} {
  const cut = (s: unknown) => String(s ?? "").slice(0, 200);
  switch (au?.state) {
    case undefined:
      return { text: t("ui-settings.autoUpdate.unknown"), tone: "muted" };
    case "disabled":
      return { text: t("ui-settings.autoUpdate.disabled"), tone: "muted" };
    case "no-source":
      return { text: t("ui-settings.autoUpdate.noSource"), tone: "muted" };
    case "current":
      return { text: t("ui-settings.autoUpdate.current"), tone: "ok" };
    case "pending":
      return {
        text: au.target
          ? t("ui-settings.autoUpdate.pendingTarget", { target: cut(au.target) })
          : t("ui-settings.autoUpdate.pending"),
        tone: "wait",
      };
    case "available":
      return {
        text: au.target
          ? t("ui-settings.autoUpdate.availableTarget", { target: cut(au.target) })
          : t("ui-settings.autoUpdate.available"),
        tone: "wait",
      };
    case "failed":
      return {
        text: t("ui-settings.autoUpdate.failed", { error: cut(au.error) || t("ui-settings.autoUpdate.failedUnknown") }),
        tone: "bad",
      };
    case "unsupported":
      return { text: t("ui-settings.autoUpdate.unsupported", { reason: cut(au.reason) }), tone: "bad" };
  }
  return { text: t("ui-settings.autoUpdate.other", { state: cut(au?.state) }), tone: "muted" };
}

/** One sentence about who can open this page now (GET /api/access). */
export function accessSummary(a: AccessStatus): string {
  const local = a.local.url ? t("ui-settings.access.local", { url: a.local.url }) : t("ui-settings.access.localOff");
  const ext = a.external.enabled
    ? a.external.listening
      ? a.external.tls
        ? t("ui-settings.access.externalTls", { url: String(a.external.url) })
        : t("ui-settings.access.externalPlain", { url: String(a.external.url) })
      : t("ui-settings.access.externalNotListening")
    : t("ui-settings.access.externalOff");
  const pass = a.passcode.effective ? t("ui-settings.access.passcode") : t("ui-settings.access.noPasscode");
  return t("ui-settings.access.summary", { local, ext, pass });
}

/** Notifications the viewer has not seen yet (`seen`: the last cursor looked at). */
export function unseenCount(items: NotificationItem[], seen: number): number {
  return items.filter(
    (n) => Number(n.id) > seen && n.state !== "handled" && n.state !== "canceled" && n.state !== "expired",
  ).length;
}
