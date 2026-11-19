import { useEffect, useReducer, useState } from "react";
import { t } from "./i18n";
import type { Snapshot } from "@daisy-ai/contracts";

/**
 * What a view knows about the data it shows. Fetching and knowing
 * what is stale are two separate things: a view learns that the server has
 * something newer from a version stamp (the push stream's cursor, or a
 * response's), never from a timer, and fetching — only the delta, in the
 * background — is how it catches up.
 *
 *   loading  nothing to show yet            skeleton; 「正在加载…」 after 150 ms
 *   cached   showing what this page kept    content + 「正在同步…」
 *   fresh    the server confirmed it is the newest version
 *   stale    the server announced a newer version; it is being fetched
 *   offline  the server can't be reached   content + 「离线，显示的是 N 分钟前的内容」
 *   error    nothing to show and it failed  message + 重试
 */
export type FreshnessKind =
  "loading" | "cached" | "fresh" | "stale" | "offline" | "error";

export interface Freshness {
  /** What the view shows: its version, when the server last confirmed it, and whether it did since this view (re)started. */
  held: { version: number; at: number; confirmed: boolean } | null;
  /** Newest version the server announced or answered with; -1 = unknown. */
  server: number;
  /** The last attempt to reach the server failed. */
  unreachable: boolean;
  /** Why nothing could be loaded (only while nothing is held). */
  error: string | null;
}

export type FreshnessEvent =
  /** Shown from a cache: version and when the server last confirmed it. */
  | { type: "cache"; version: number; at: number }
  /**
   * The server answered with this version; `reset` = its log went back (a
   * restore): what it says now is the newest, not the higher cursor seen.
   */
  | { type: "data"; version: number; at: number; reset?: boolean }
  /** The server announced a version (push). */
  | { type: "announce"; version: number }
  | { type: "fail"; error: string }
  /** The view stopped listening (hidden): what it holds is unconfirmed again. */
  | { type: "suspend" }
  | { type: "reset" };

export const initialFreshness: Freshness = {
  held: null,
  server: -1,
  unreachable: false,
  error: null,
};

export function freshnessReducer(s: Freshness, e: FreshnessEvent): Freshness {
  switch (e.type) {
    case "cache":
      // A cache never overrides what the server already confirmed.
      if (s.held && s.held.version >= e.version) return s;
      return {
        ...s,
        held: { version: e.version, at: e.at, confirmed: false },
      };
    case "data":
      if (
        s.held?.confirmed &&
        s.held.version === e.version &&
        s.held.at === e.at &&
        !s.unreachable &&
        s.server <= e.version
      )
        return s;
      return {
        held: { version: e.version, at: e.at, confirmed: true },
        server: e.reset ? e.version : Math.max(s.server, e.version),
        unreachable: false,
        error: null,
      };
    case "announce":
      return e.version > s.server ? { ...s, server: e.version } : s;
    case "fail":
      return s.held
        ? s.unreachable
          ? s
          : { ...s, unreachable: true }
        : { ...s, unreachable: true, error: e.error };
    case "suspend":
      return s.held?.confirmed
        ? { ...s, held: { ...s.held, confirmed: false } }
        : s;
    case "reset":
      return initialFreshness;
  }
}

export function freshnessKind(s: Freshness): FreshnessKind {
  if (!s.held) return s.error ? "error" : "loading";
  if (s.unreachable) return "offline";
  if (s.server > s.held.version) return "stale";
  return s.held.confirmed ? "fresh" : "cached";
}

/**
 * What a view may claim, given its connection: without the live
 * socket — closed, reconnecting, or subscribed but not yet caught up with
 * the cursor `ready` reported — nothing tells it about newer versions, so
 * data the server once confirmed is only `cached` (「正在同步…」), never
 * `fresh`.
 */
export function viewFreshness(
  s: Freshness,
  connection: "live" | "reconnecting" | "offline" | string,
): FreshnessKind {
  const kind = freshnessKind(s);
  return kind === "fresh" && connection !== "live" ? "cached" : kind;
}

/** 「3 分钟前」: how old what an offline view shows is. */
export function ageText(at: number, now: number) {
  const d = Math.max(0, now - at);
  if (d < 60_000) return t("ui-queue.age.underMinute");
  if (d < 3600_000) return t("ui-queue.age.minutes", { n: Math.floor(d / 60_000) });
  if (d < 86400_000) return t("ui-queue.age.hours", { n: Math.floor(d / 3600_000) });
  return t("ui-queue.age.days", { n: Math.floor(d / 86400_000) });
}

export interface FreshnessCopy {
  loading: string;
  syncing: string;
  offline: string;
}
/** The default words, in the UI's language (read at use: getters). */
export const defaultFreshnessCopy: FreshnessCopy = {
  get loading() {
    return t("ui-queue.fresh.loading");
  },
  get syncing() {
    return t("ui-queue.fresh.syncing");
  },
  get offline() {
    // `{age}` is filled by freshnessText.
    return t.dynamic("ui-queue.fresh.offline");
  },
};

/** The words a view shows for its state; "" = nothing to say (fresh). */
export function freshnessText(
  s: Freshness,
  now: number,
  copy: FreshnessCopy = defaultFreshnessCopy,
) {
  const kind = freshnessKind(s);
  if (kind === "loading") return copy.loading;
  if (kind === "cached" || kind === "stale") return copy.syncing;
  if (kind === "offline")
    return copy.offline.replace("{age}", ageText(s.held!.at, now));
  if (kind === "error") return s.error || "";
  return "";
}

/** The freshness state machine of one view. */
export function useFreshness(init?: () => Freshness) {
  return useReducer(
    freshnessReducer,
    undefined,
    init || (() => initialFreshness),
  );
}

/** True once `on` has held for `ms` (loading hints wait 150 ms, so fast loads never flash one). */
export function useDelayed(on: boolean, ms = 150) {
  const [late, setLate] = useState(false);
  useEffect(() => {
    if (!on) {
      setLate(false);
      return;
    }
    const t = setTimeout(() => setLate(true), ms);
    return () => clearTimeout(t);
  }, [on, ms]);
  return on && late;
}

/** Re-render every `ms` while `on` (the 「N 分钟前」 of an offline view ages). */
export function useTicking(on: boolean, ms = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [on, ms]);
  return now;
}

/**
 * Where the conversation's AI is, beyond the data:
 *   device-offline  its device (runner) has not been heard from: nothing runs until it is back
 *   onlining        a message waits for the AI to start (queued, or running with no output yet)
 *   null            nothing to say
 */
export type AiPresence = "device-offline" | "onlining" | null;
export function aiPresence(snap: Snapshot | null): AiPresence {
  if (!snap) return null;
  if (snap.node && !snap.node.online) return "device-offline";
  const status = snap.session.status,
    online = !!snap.session.live?.online;
  // An online AI picks a queued message up at once (or waits for a slot).
  if (status === "queued") return online ? null : "onlining";
  if (status !== "running" || online) return null;
  // Claimed, its process starting: no output since the newest user message
  // (or Agent wake marker) yet.
  for (let i = snap.items.length - 1; i >= 0; i--) {
    const it = snap.items[i];
    if (it.kind === "user" || it.category === "wake") return "onlining";
    if (it.kind === "assistant" || it.kind === "tool" || it.kind === "thinking")
      return null;
  }
  return "onlining";
}
