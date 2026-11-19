/**
 * P5-03 (ADR-142) / P6-26 (P5N-5, P5N-6): a paired device's connection —
 * moved out of the app shell (apps/app/App.tsx) so it can be tested
 * against a real Daisy.
 *
 * - The device's session is the Bearer; when it is refused (run out after
 *   12 hours, or the device was revoked) the device credential is traded
 *   for a new one (`credentials({ refresh: true })` — also for the live
 *   socket, at once when it closes with 1008 / 4401).
 * - The trade itself refused with 401 `device_invalid` (the device was
 *   revoked, a PIN reset, idle too long): the device is given up — its credential and session forgotten,
 *   every kept conversation view dropped, `gone()` told once (the page goes
 *   back to its login screen and says why).
 * - `watchPageShown`: a page coming back (into view, focus, online, out of
 *   the back-forward cache, resumed after being frozen — or a watchdog that
 *   sees it was not running) asks again at once on a connection of its own
 *   (`check`) — a background page's timers may have been held back by the
 *   browser for up to a minute, or the page frozen outright (P6-27, P5N-8).
 */
import { DaisyClient, DaisyError, type FetchLike, type WebSocketConstructor } from "@daisy-ai/client";
import type { PairedDevice } from "./device-store";
import { clearSessionCache } from "./session-cache";

/** Where the page keeps what a paired device holds. */
export interface PairedDeviceKeep {
  /** Keep this page's device session (null: forget it). */
  session(token: string | null): Promise<void> | void;
  /** Forget the device: its credential (the pairing). */
  forget(): Promise<void> | void;
}

/** The server said no to this credential (not a network trouble). */
export const credentialRefused = (e: unknown): boolean =>
  e instanceof DaisyError && (e.status === 401 || e.status === 403);

/**
 * P6-26 review L-2: the trade's answer that ends the pairing — 401
 * `device_invalid` (revoked, idle too long, a PIN reset). Anything else
 * (403 `device_face` / `cross_site`, 429, another 401) keeps the pairing:
 * the page shows the error and may try again.
 */
export const deviceInvalid = (e: unknown): boolean =>
  e instanceof DaisyError && e.status === 401 && e.code === "device_invalid";

/** P6-27: what `check` found — still paired, given up, or Daisy did not answer in time. */
export type DeviceCheck = "in" | "gone" | "unknown";

export interface PairedDeviceClient {
  client: DaisyClient;
  /** The device was given up (the trade was refused). */
  readonly gone: boolean;
  /**
   * P6-27 (P5N-8): ask Daisy now whether this device is still paired —
   * `GET /api/me` with the page's session, and on a 401 a trade of the
   * credential — on a connection of its own, never queued behind the
   * client's requests or a trade already under way, each step bounded by
   * `checkMs`. A refused trade (401 `device_invalid`) gives the device up
   * (`gone()`) like everywhere else.
   */
  check(): Promise<DeviceCheck>;
}

/** P6-27: how long one step of `check` may take (the page asks again later when it timed out). */
export const DEVICE_CHECK_MS = 4000;

const within = <T>(p: Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((ok, fail) => {
    const timer = setTimeout(() => fail(new Error("timeout")), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        ok(v);
      },
      (e) => {
        clearTimeout(timer);
        fail(e);
      },
    );
  });

/**
 * A connection for a paired device. Review M-2: always `device.url` — the
 * credential is only ever sent to the Daisy the device paired with.
 */
export function pairedDeviceClient(
  device: PairedDevice,
  token: string,
  o: {
    keep: PairedDeviceKeep;
    /** Called once when the device is given up. */
    gone: () => void;
    /** Tests: the transport (as DaisyClient's options). */
    fetch?: FetchLike;
    WebSocket?: WebSocketConstructor;
    /** Tests: `check`'s bound per step (default DEVICE_CHECK_MS). */
    checkMs?: number;
  },
): PairedDeviceClient {
  let over = false,
    refusal: unknown = null;
  const transport = {
    ...(o.fetch ? { fetch: o.fetch } : {}),
    ...(o.WebSocket ? { WebSocket: o.WebSocket } : {}),
  };
  const giveUp = async (e: unknown) => {
    if (over) return;
    over = true;
    refusal = e;
    // P6-26: nothing it loaded stays on this page.
    clearSessionCache();
    client.forgetCached();
    await Promise.resolve(o.keep.forget()).catch(() => {});
    await Promise.resolve(o.keep.session(null)).catch(() => {});
    o.gone();
  };
  /** The device credential for a new session (kept for the next load). */
  const trade = async (): Promise<string> => {
    // Given up already: no trade with a credential known to be void.
    if (over) throw refusal;
    try {
      // A connection of its own: the client may be waiting for this answer.
      const r = await new DaisyClient(device.url, "", transport).deviceSession(device.secret);
      await o.keep.session(r.token);
      return r.token;
    } catch (e) {
      if (deviceInvalid(e)) await giveUp(e);
      throw e;
    }
  };
  const client: DaisyClient = new DaisyClient(device.url, token, {
    ...transport,
    credentials: () => trade(),
  });
  const checkMs = o.checkMs ?? DEVICE_CHECK_MS;
  const check = async (): Promise<DeviceCheck> => {
    if (over) return "gone";
    try {
      const f: FetchLike = o.fetch ?? ((url, init) => fetch(url, init));
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), checkMs);
      let status: number;
      try {
        const used = client.token;
        const r = await f(device.url + "/api/me", {
          headers: used ? { Authorization: `Bearer ${used}` } : {},
          cache: "no-store",
          signal: controller.signal,
        });
        status = r.status;
        // The body is not needed (and not kept): only whether it was let in.
        void r.body?.cancel?.().catch?.(() => {});
      } finally {
        clearTimeout(timer);
      }
      if (status === 200) return "in";
      if (status !== 401) return "unknown";
      const fresh = await within(trade(), checkMs);
      client.token = fresh;
      return "in";
    } catch {
      return over ? "gone" : "unknown";
    }
  };
  return {
    client,
    get gone() {
      return over;
    },
    check,
  };
}

/**
 * The first load of a paired device's page: its kept session, else a new
 * one for its credential (a new window has no session yet). `in`: signed
 * in; `outage`: Daisy could not be reached or asked to wait (the pairing
 * is kept, the page shows the workspace and retries); `gone`: the device
 * was given up; `refused`: refused otherwise (the login screen shows
 * `error`; the pairing is kept).
 */
export async function restorePairedDevice(
  d: PairedDeviceClient,
  /**
   * P6-27 (P5N-7): the most the first load waits — then it is an outage
   * (the page shows the workspace and keeps trying; a refusal that comes
   * later still sends it to the login screen). Never an endless wait.
   */
  ms = RESTORE_LIMIT_MS,
): Promise<{ state: "in" | "outage" | "gone" | "refused"; error?: Error }> {
  try {
    await within(d.client.request("/me"), ms);
    return { state: "in" };
  } catch (e) {
    if (d.gone) return { state: "gone" };
    return credentialRefused(e) ? { state: "refused", error: e as Error } : { state: "outage", error: e as Error };
  }
}
/** P6-27: `restorePairedDevice`'s bound. */
export const RESTORE_LIMIT_MS = 6000;

interface EventSource {
  addEventListener(type: string, fn: () => void): void;
  removeEventListener(type: string, fn: () => void): void;
}

/** P6-27: `watchPageShown`'s timing (tests shorten it). */
export interface PageShownTiming {
  /** The watchdog's tick. */
  tickMs: number;
  /** A tick this late means the page was frozen or held back: check now. */
  jumpMs: number;
  /** After a check Daisy did not answer: ask again this often (while shown). */
  retryMs: number;
}
export const PAGE_SHOWN_TIMING: PageShownTiming = { tickMs: 1000, jumpMs: 4000, retryMs: 5000 };

/**
 * P6-26 / P6-27 (P5N-6, P5N-8): a paired device's page asks Daisy again
 * the moment it is back — shown (`visibilitychange`), focused, restored
 * from the back-forward cache (`pageshow`), resumed after the browser froze
 * it (`resume`), back online — and whenever its own clock shows it was not
 * running (a watchdog tick far later than due: frozen or held back without
 * any of those events). Each time: `check()` (its own connection and time
 * bound, not queued behind anything the page was doing when it was frozen),
 * and every open conversation watch is woken (`client.wake()`: a reconnect
 * back-off forgotten, a socket that may have died meanwhile pinged). A
 * revoked device's page so leaves for its login screen as soon as it is
 * seen. A check Daisy did not answer is asked again every `retryMs` while
 * the page is shown. A hidden page asks nothing. Returns the stop function.
 */
export function watchPageShown(
  d: Pick<PairedDeviceClient, "check"> & { client: Pick<DaisyClient, "wake"> },
  win: EventSource,
  doc?: EventSource & { visibilityState?: string },
  timing: PageShownTiming = PAGE_SHOWN_TIMING,
  now: () => number = Date.now,
): () => void {
  let running = false,
    stopped = false,
    unanswered = false,
    asked = 0,
    lastTick = now();
  const shown = () => !doc?.visibilityState || doc.visibilityState === "visible";
  const back = () => {
    if (stopped || !shown()) return;
    d.client.wake();
    // At most one at a time — each is time-bound, so one never blocks the next for long.
    if (running) return;
    running = true;
    asked = now();
    void d
      .check()
      .then((r) => {
        unanswered = r === "unknown";
      })
      .catch(() => {
        unanswered = true;
      })
      .finally(() => {
        running = false;
      });
  };
  const tick = () => {
    const t = now(),
      late = t - lastTick > timing.jumpMs;
    lastTick = t;
    if (late || (unanswered && t - asked >= timing.retryMs)) back();
  };
  const timer = setInterval(tick, timing.tickMs);
  const winEvents = ["focus", "pageshow", "online"];
  const docEvents = ["visibilitychange", "resume"];
  for (const e of winEvents) win.addEventListener(e, back);
  for (const e of docEvents) doc?.addEventListener(e, back);
  return () => {
    stopped = true;
    clearInterval(timer);
    for (const e of winEvents) win.removeEventListener(e, back);
    for (const e of docEvents) doc?.removeEventListener(e, back);
  };
}

/**
 * The pairing code in the address bar's `#pair=…` (P5-03); null: none.
 * A malformed one is "" (the login screen opens in the pairing mode, empty).
 */
export function pairCodeFromHash(hash: string | null | undefined): string | null {
  const m = /(?:^#|&)pair=([^&]*)/.exec(hash || "");
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]!).trim();
  } catch {
    return "";
  }
}
