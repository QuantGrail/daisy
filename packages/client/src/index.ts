import type {
  Agent,
  HostBranding,
  Item,
  ItemsPage,
  SessionSettings,
  Snapshot,
  MessageContextInput,
  TerminalResult,
  Attachment,
  Profile,
  NodeInfo,
  Workspace,
  DirectoryListing,
  User,
  Me,
  LiveActivity,
  ContextThreshold,
  DaisySchedule,
  MyPromptView,
  MyPromptUpdate,
  SessionPromptView,
  NotificationsPage,
  DaisyEvent,
  SessionPromptExtraUpdate,
  PromptLayerAdminView,
  PromptLayerSettings,
  ScheduleUpdate,
  ServerTimeZone,
  ScheduleCreate,
  QueueJumpResult,
  QueueMergeJumpResult,
  QueueMergeSteerResult,
  QueueRemoveResult,
} from "@daisy-ai/contracts";
// P1-06: the answers of GET /api/catalog and /api/profiles/:id/auto-compact
// are contracts types now (the route table names them).
export type { AutoCompactStatus, Catalog } from "@daisy-ai/contracts";
import type { AutoCompactStatus, Catalog } from "@daisy-ai/contracts";
import {
  api,
  fillPath,
  LIVE_CLOSE,
  HARNESS_CONFIG_OPERATIONS,
  type ApiBody,
  type AnyRoute,
  type ApiInput,
  type ApiOutput,
  type ApiQuery,
  type PinStatus,
  PIN_GRANT_HEADER,
  interpolate,
  type MessageKey,
} from "@daisy-ai/contracts";
// P6-23b (ADR-159): the reference pack's client area — the text when the host set no translator.
import CLIENT_EN from "../../contracts/locales/en/client.json" with { type: "json" };

/**
 * P6-23b (ADR-159 §3, §10): the client's own messages (a timeout, a
 * connection lost, an answer it cannot read) are message keys in the
 * `client` area. A host shows them in its language by handing its
 * translator (`setClientTranslator(t.dynamic)`, with the `client` area
 * loaded); without one they are the reference pack's (English) — never a
 * raw key. Errors raised this way carry a stable `code` and `key` /
 * `params` (`localized: true`), so a host may also say them itself.
 */
export type ClientTranslate = (key: string, params?: Record<string, unknown>) => string;
const englishClientText: ClientTranslate = (key, params) =>
  interpolate((CLIENT_EN as Record<string, string>)[key] ?? key, params);
let clientT: ClientTranslate = englishClientText;
/** Say the client's messages with the host's translator (undefined: the built-in English). */
export function setClientTranslator(t?: ClientTranslate): void {
  clientT = t ?? englishClientText;
}
const said = (key: MessageKey, params?: Record<string, string | number>) => clientT(key, params);

/** A failure the client itself noticed (no answer from the server): `code`, and its text by key. */
export class ClientError extends Error {
  readonly localized = true;
  constructor(
    readonly code: string,
    readonly key: MessageKey,
    readonly params: Record<string, string | number> = {},
  ) {
    super(said(key, params));
  }
}
/** The request header a PIN grant rides in (local-api.md §6, P1-05). */
export { PIN_GRANT_HEADER };
/**
 * GET /api/pin (P1-05): set or not, lockout, and D-36's history — when and
 * through which entry it was set or reset.
 */
export type PinStatusView = PinStatus;
/** GET / PUT /api/autostart (P1-09). */
export type AutostartView = ApiOutput<typeof api.settings.autostartStatus>;
export class DaisyError extends Error {
  constructor(
    public status: number,
    message: string,
    /** Server's machine-readable reason (e.g. `gateway_user_invalid`), if any. */
    public code?: string,
    /** Seconds from a `Retry-After` header (429 / 503), if any. */
    public retryAfter?: number,
    /**
     * The whole answer (P1-08: a refused 「立即重启」 carries `interrupts`
     * and the `confirm` token for them).
     */
    public body?: Record<string, unknown>,
  ) {
    super(message);
  }
}
/** `Retry-After` as seconds (delta or HTTP date); undefined when absent. */
export function retryAfterSeconds(h: string | null): number | undefined {
  if (!h) return;
  const n = Number(h);
  if (Number.isFinite(n) && n >= 0) return Math.ceil(n);
  const at = Date.parse(h);
  return Number.isNaN(at)
    ? undefined
    : Math.max(0, Math.ceil((at - Date.now()) / 1000));
}
/** Conditional-GET memory of one client. */
const ETAG_ENTRIES = 64;
const ETAG_BYTES = 8 * 1024 * 1024;

/**
 * P2-04 (ADR-115): what a connection's `credentials()` is asked. The
 * answer is the Bearer credential for that Daisy: an external issuer's
 * token for the owner (an interface's backend), a web session, the
 * command line's credential — whatever the caller holds.
 */
export interface CredentialRequest {
  /**
   * true: the last credential was refused (a 401, or the live socket
   * closed with 1008 — expired, issuer changed): hand back a new one.
   * false: the one held, if still good (the provider may cache).
   */
  refresh: boolean;
  /** Which Daisy is asking (a provider may give each its own token / audience). */
  baseUrl: string;
  /** The connection's name in a `DaisyConnections`, if any. */
  id?: string;
}
export type CredentialsProvider = (
  r: CredentialRequest,
) => string | Promise<string>;
/** The fetch a connection uses (default: the global one). */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
/** The WebSocket constructor a connection uses (default: the global one). */
export type WebSocketConstructor = new (url: string) => WebSocket;

/** P2-04: per-connection options (all optional: the web page passes none). */
export interface DaisyClientOptions {
  /**
   * Where the Bearer credential comes from. Asked before the first request
   * and the first live subscription; asked again with `refresh: true`
   * after the guard's 401 (`WWW-Authenticate: Bearer error="invalid_token"`
   * — the request is then sent once more: it was refused before any
   * handler ran, so nothing happens twice) and when the live socket
   * closes with 1008 or 4401 (`LIVE_CLOSE`: a revoked paired device — P6-26
   * asks at once, on the close). Without it, `token` is used as it is.
   */
  credentials?: CredentialsProvider;
  /** fetch to use (a backend's own agent: a pinned TLS certificate, a proxy). */
  fetch?: FetchLike;
  /** WebSocket to use (default: globalThis.WebSocket; Node 22+ has one). */
  WebSocket?: WebSocketConstructor;
  /** A name for this connection (passed to `credentials`). */
  id?: string;
  /**
   * Told after every request whether the Daisy answered at all (any HTTP
   * status = reachable; a network failure or timeout = not).
   */
  onReachability?: (reachable: boolean, error?: unknown) => void;
}

export class DaisyClient {
  /**
   * P6-20 (ADR-159): the language every client asks the server's messages
   * in (`Accept-Language`) — the web UI sets it to the language it shows.
   * Unset: none sent (the server uses the owner's setting).
   */
  static language: string | undefined;
  /**
   * `token` may be empty in host mode: the same-origin gateway authenticates
   * requests from the browser cookie, and the live socket from its upgrade
   * request. No Daisy token is stored in the browser then.
   *
   * P2-04: `opts.credentials` instead of a fixed token — then `token` is
   * the last credential it gave (kept until refused).
   */
  constructor(
    public baseUrl: string,
    public token: string = "",
    public readonly opts: DaisyClientOptions = {},
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }
  /** The connection's name (`opts.id`), if any. */
  get id() {
    return this.opts.id;
  }
  private get fetchImpl(): FetchLike {
    return this.opts.fetch ?? ((url, init) => fetch(url, init));
  }
  /** P6-27: the open conversation watches' wake-ups (`wake`). */
  private wakers = new Set<() => void>();
  /**
   * P6-27 (P5N-8): the page is back (shown, focused, resumed after the
   * browser froze it, online): every open conversation watch fetches what
   * changed now, a socket that is down reconnects now — its back-off
   * forgotten — and one that looks up is pinged now (a socket that died
   * while the page was frozen is noticed within `pongMs`, not at the next
   * ping). Cheap; safe to call often.
   */
  wake() {
    for (const w of [...this.wakers]) w();
  }
  private pendingCredential: Promise<string> | undefined;
  /**
   * P2-04: the Bearer credential to send now. With `credentials`, asked
   * once and kept; `refresh` asks again. Concurrent asks share one call.
   */
  async credential(refresh = false): Promise<string> {
    const provide = this.opts.credentials;
    if (!provide) return this.token;
    if (!refresh && this.token) return this.token;
    if (!this.pendingCredential) {
      const asked = (async () => {
        try {
          const t = await provide({
            refresh,
            baseUrl: this.baseUrl,
            ...(this.opts.id !== undefined ? { id: this.opts.id } : {}),
          });
          if (typeof t !== "string")
            throw new ClientError("no_credential", "client.error.noCredential");
          this.token = t;
          return t;
        } finally {
          this.pendingCredential = undefined;
        }
      })();
      this.pendingCredential = asked;
    }
    return this.pendingCredential;
  }
  /**
   * `used` was refused: a new credential — unless another request already
   * got one meanwhile (many requests refused at once ask only once).
   */
  private async renewed(used: string): Promise<string> {
    if (this.pendingCredential) return this.pendingCredential;
    if (this.token && this.token !== used) return this.token;
    return this.credential(true);
  }
  /**
   * the last body of each GET path with its ETag. The next read of
   * that path sends If-None-Match; a 304 parses the kept text again (every
   * caller gets its own objects, nothing shared can be mutated). Bounded:
   * at most ETAG_ENTRIES paths and ETAG_BYTES held (a JS string costs 2
   * bytes per UTF-16 unit), oldest use first out. Kept per server + token:
   * a changed `baseUrl` / `token` (another login) starts empty.
   */
  private etags = new Map<string, { tag: string; text: string }>();
  private etagBytes = 0;
  private etagOwner = "";
  /** Drop every kept body (sign-out; also automatic on a new token / server). */
  forgetCached() {
    this.etags.clear();
    this.etagBytes = 0;
  }
  private keptFor(path: string) {
    // P2-04: with `credentials`, a renewed token is the same caller (the
    // kept bodies stay); a fixed token keys them as before.
    const owner =
      this.baseUrl +
      "\n" +
      (this.opts.credentials ? "\u0000credentials" : this.token);
    if (owner !== this.etagOwner) {
      this.forgetCached();
      this.etagOwner = owner;
    }
    return this.etags.get(path);
  }
  private remember(path: string, tag: string | null, text: string) {
    this.keptFor(path);
    const old = this.etags.get(path);
    if (old) {
      this.etags.delete(path);
      this.etagBytes -= old.text.length * 2;
    }
    const size = text.length * 2;
    if (!tag || size > ETAG_BYTES / 4) return;
    this.etags.set(path, { tag, text });
    this.etagBytes += size;
    for (const [k, v] of this.etags) {
      if (this.etags.size <= ETAG_ENTRIES && this.etagBytes <= ETAG_BYTES)
        break;
      this.etags.delete(k);
      this.etagBytes -= v.text.length * 2;
    }
  }
  async request<T = any>(
    path: string,
    method = "GET",
    body?: unknown,
    /** Extra request headers (P1-08: the PIN grant, `daisy-pin-grant`). */
    headers?: Record<string, string>,
  ): Promise<T> {
    const kept = method === "GET" ? this.keptFor(path) : undefined;
    // No provider: no await before sending (the request starts in the
    // caller's tick, as before P2-04).
    let bearer = this.opts.credentials ? await this.credential() : this.token;
    const send = async () => {
      // AbortController works on native Hermes as well as browsers; no
      // dependency on the newer AbortSignal.timeout static helper.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      try {
        return await this.fetchImpl(this.baseUrl + "/api" + path, {
          method,
          headers: {
            ...(body !== undefined
              ? { "Content-Type": "application/json" }
              : {}),
            ...(kept ? { "If-None-Match": kept.tag } : {}),
            ...(DaisyClient.language ? { "Accept-Language": DaisyClient.language } : {}),
            ...this.authHeaders(bearer),
            ...headers,
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          signal: controller.signal,
        });
      } catch (error) {
        // Our own timer fired: browsers only say "signal is aborted without
        // reason". Stays a plain Error (status undefined = network trouble).
        if (controller.signal.aborted)
          throw new ClientError("timeout", "client.error.timeout", { s: 15 });
        throw error;
      } finally {
        clearTimeout(timer);
      }
    };
    let r: Response;
    try {
      try {
        r = await send();
      } catch (error) {
        // A restarted server can close a pooled keep-alive socket. Only reads
        // retry automatically; mutation callers retain their idempotency key.
        if (method !== "GET") throw error;
        await new Promise((resolve) => setTimeout(resolve, 200));
        r = await send();
      }
      // P2-04: a refused credential (expired, rotated) — ask for a new one
      // and send once more. Only the guard's 401 (`WWW-Authenticate:
      // Bearer error="invalid_token"`), answered before any handler ran:
      // sending a change again does not do it twice.
      if (
        r.status === 401 &&
        this.opts.credentials &&
        /invalid_token/.test(r.headers.get("www-authenticate") ?? "")
      ) {
        const used = bearer;
        bearer = await this.renewed(used);
        if (bearer && bearer !== used) r = await send();
      }
      this.opts.onReachability?.(true);
    } catch (error) {
      this.opts.onReachability?.(false, error);
      throw error;
    }
    let data: any;
    try {
      if (r.status === 304 && kept) {
        // Unchanged since the kept body: parse it afresh.
        this.remember(path, kept.tag, kept.text);
        return JSON.parse(kept.text);
      }
      const text = await r.text();
      data = JSON.parse(text);
      if (method === "GET")
        this.remember(path, r.ok ? r.headers.get("etag") : null, text);
    } catch {
      throw new DaisyError(r.status, said("client.error.invalidResponse"), "invalid_response");
    }
    if (!r.ok)
      throw new DaisyError(
        r.status,
        data.error || `HTTP ${r.status}`,
        typeof data.code === "string" ? data.code : undefined,
        retryAfterSeconds(r.headers.get("retry-after")),
        data && typeof data === "object" ? data : undefined,
      );
    return data;
  }
  /**
   * P1-06 (ADR-107): call a route by its definition (`api.*` in
   * @daisy-ai/contracts) — the path, query, body and answer types all come
   * from it: `client.call(api.sessions.cancel, { params: { id } })`.
   * A POST / PUT / PATCH with no body sends `{}`.
   */
  call<D extends AnyRoute>(
    def: D,
    input: ApiInput<D>,
    /** P1-08: a route with `pin: true` takes a PIN grant (`pinGrant()`). */
    opts: { pinGrant?: string } = {},
  ): Promise<ApiOutput<D>> {
    const i = input as {
      params?: Record<string, string>;
      query?: Record<string, unknown>;
      body?: unknown;
    };
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(i.query ?? {}))
      if (v !== undefined && v !== null) qs.set(k, String(v));
    const path =
      fillPath(def.path, i.params).replace(/^\/api/, "") +
      (qs.size ? "?" + qs : "");
    const body =
      i.body !== undefined
        ? i.body
        : def.method === "GET" || def.method === "DELETE"
          ? undefined
          : {};
    return this.request<ApiOutput<D>>(
      path,
      def.method,
      body,
      opts.pinGrant ? { [PIN_GRANT_HEADER]: opts.pinGrant } : undefined,
    );
  }
  private authHeaders(token = this.token): Record<string, string> {
    return token ? { Authorization: `Bearer ${token}` } : {};
  }
  health() {
    return this.request<{
      ok: boolean;
      apiVersion: number;
      /** Host branding for the web app (server DAISY_BRANDING), if configured. */
      branding?: HostBranding;
      /** DAISY_ORIGINS: other origins host links may point to. */
      hostOrigins?: string[];
      /** P6-20: the owner's display language (absent on older servers). */
      language?: string;
    }>("/health");
  }
  /** P6-20 (ADR-159): the display language — the owner's setting, the one in use, the packs present. */
  language() {
    return this.call(api.settings.languageShow, {});
  }
  /** Set the owner's display language (`null`: follow the system). */
  setLanguage(language: string | null) {
    return this.call(api.settings.languageSet, { body: { language } });
  }
  /** One language's interface text (public: the sign-in page needs it too). */
  locales(lang: string, areas?: string[]) {
    return this.call(api.system.locales, {
      params: { lang },
      ...(areas?.length ? { query: { areas: areas.join(",") } } : {}),
    });
  }
  /** The owner, and the channel / face this credential is recognised as (P1-03). */
  me() {
    return this.request<Me>("/me");
  }
  /** an identity's auto-compact threshold and its processes' state. */
  autoCompact(profileId: string) {
    return this.request<AutoCompactStatus>(
      `/profiles/${encodeURIComponent(profileId)}/auto-compact`,
    );
  }
  /**
   * Set an identity's auto-compact threshold (tokens; Claude: its native
   * compaction window; null = the CLI default). Online processes restart
   * with it once idle; 422 when the identity's device cannot apply it.
   */
  setAutoCompact(profileId: string, tokens: number | null) {
    return this.request<Profile & { autoCompact: AutoCompactStatus }>(
      `/profiles/${encodeURIComponent(profileId)}`,
      "PATCH",
      { autoCompactTokens: tokens },
    );
  }
  /** 立即重启: apply the threshold now, interrupting what those processes do. */
  restartForAutoCompact(profileId: string) {
    return this.request<AutoCompactStatus>(
      `/profiles/${encodeURIComponent(profileId)}/auto-compact/restart`,
      "POST",
      {},
    );
  }
  /**
   * P1-03: the web page's session — with the one-time code `daisy open`
   * printed, or none (this machine, passcode off). Sets `token`.
   */
  async webSession(code?: string) {
    const r = await this.request<{
      token: string;
      expiresAt: number;
      face: "local" | "external";
    }>("/web/session", "POST", code ? { code } : {});
    this.token = r.token;
    return r;
  }
  /** P1-03: end this web session. */
  webLogout() {
    return this.request<{ ok: true }>("/web/session", "DELETE");
  }
  // ── P1-08: the settings page ──────────────────────────────────────────
  /** P1-08: the session notifications (一轮结束、审批卡片、AI 出错). */
  notifications(query: ApiQuery<typeof api.notifications.notifications> = {}) {
    return this.call(api.notifications.notifications, { query });
  }
  /**
   * P2-04: follow this Daisy's session notifications from a cursor of its
   * own (`after`; 0 = from the start). Each answer that has something is
   * handed to `items` with the cursor to keep (persist it to resume after
   * a restart). Polls every `pollMs`; on failure backs off up to `maxMs`
   * and keeps the cursor — another Daisy's follower is not affected.
   * (P2-03's event outlet: `followEvents`.)
   */
  followNotifications(
    h: NotificationFollowHandlers,
    opts: {
      after?: number;
      pollMs?: number;
      maxMs?: number;
      sessionId?: string;
      limit?: number;
    } = {},
  ): CursorFollow {
    const pollMs = opts.pollMs ?? 5000,
      maxMs = opts.maxMs ?? 60000;
    let cursor = opts.after ?? 0,
      closed = false,
      timer: any,
      failures = 0,
      running: Promise<void> | null = null;
    const once = async () => {
      try {
        // Drain: a full page means there may be more right behind it.
        for (;;) {
          const page = await this.notifications({
            after: cursor,
            ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
            ...(opts.limit ? { limit: opts.limit } : {}),
          });
          if (closed) return;
          failures = 0;
          const next = Math.max(cursor, page.cursor);
          const moved = next !== cursor;
          cursor = next;
          if (page.items.length) await h.items(page.items, cursor);
          if (!moved || page.items.length < (opts.limit ?? 50)) break;
        }
      } catch (e) {
        if (closed) return;
        failures++;
        h.error?.(e as Error);
      }
    };
    const loop = () => {
      if (closed) return;
      running = once().finally(() => {
        running = null;
        if (closed) return;
        const wait = failures
          ? Math.min(maxMs, pollMs * 2 ** Math.min(failures - 1, 6))
          : pollMs;
        timer = setTimeout(loop, wait);
      });
    };
    loop();
    return {
      cursor: () => cursor,
      refresh: () => {
        if (closed || running) return;
        clearTimeout(timer);
        loop();
      },
      close: () => {
        closed = true;
        clearTimeout(timer);
      },
    };
  }
  /** P2-03: one page of the event outlet (`GET /api/events`). */
  events(query: ApiQuery<typeof api.events.list> = {}) {
    return this.call(api.events.list, { query });
  }
  /** P2-03: the open cards and the cursor to read on from. */
  eventsSnapshot() {
    return this.call(api.events.snapshot, {});
  }
  /**
   * P2-03 / P2-04: follow this Daisy's event outlet (docs/contracts/
   * events.md) by sequence number, the way `followNotifications` follows
   * the notifications. Without `after` it starts from a snapshot (the open
   * cards, `snapshot: true`). Then it long-polls (`waitS`, at most 10:
   * the client's requests give up after 15 s) and hands each page to
   * `events` with the cursor to keep — persist it after handling, pass it
   * as `after` to resume; a page may come twice after a crash, so
   * de-duplicate by `id`. A `cursor_reset` (410: the cursor is older than
   * what was kept, or the Daisy's data was rebuilt) takes a new snapshot
   * and reads on from it. On failure it backs off up to `maxMs` and keeps
   * the cursor — another Daisy's follower is not affected.
   */
  followEvents(
    h: EventFollowHandlers,
    opts: {
      after?: number;
      waitS?: number;
      pollMs?: number;
      maxMs?: number;
      limit?: number;
    } = {},
  ): CursorFollow {
    const waitS = Math.max(0, Math.min(10, opts.waitS ?? 10)),
      pollMs = opts.pollMs ?? 1000,
      maxMs = opts.maxMs ?? 60000;
    let cursor: number | undefined = opts.after,
      closed = false,
      timer: any,
      failures = 0,
      running: Promise<void> | null = null;
    const snapshot = async () => {
      const s = await this.eventsSnapshot();
      if (closed) return;
      cursor = s.cursor;
      await h.events(s.events, s.cursor, { snapshot: true });
    };
    const once = async () => {
      try {
        if (cursor === undefined) await snapshot();
        for (;;) {
          if (closed) return;
          let page;
          try {
            page = await this.events({
              after: cursor,
              wait: waitS,
              ...(opts.limit ? { limit: opts.limit } : {}),
            });
          } catch (e) {
            if (
              e instanceof DaisyError &&
              e.status === 410 &&
              e.code === "cursor_reset"
            ) {
              h.reset?.(cursor ?? 0);
              cursor = undefined;
              await snapshot();
              continue;
            }
            throw e;
          }
          if (closed) return;
          failures = 0;
          if (page.events.length)
            await h.events(page.events, page.cursor, { snapshot: false });
          cursor = Math.max(cursor ?? 0, page.cursor);
          if (!page.hasMore) break;
        }
      } catch (e) {
        if (closed) return;
        failures++;
        h.error?.(e as Error);
      }
    };
    const loop = () => {
      if (closed) return;
      running = once().finally(() => {
        running = null;
        if (closed) return;
        // A long poll waited already: go straight on; without one, poll.
        const wait = failures
          ? Math.min(maxMs, pollMs * 2 ** Math.min(failures - 1, 6))
          : waitS > 0
            ? 0
            : pollMs;
        timer = setTimeout(loop, wait);
      });
    };
    loop();
    return {
      cursor: () => cursor ?? 0,
      refresh: () => {
        if (closed || running) return;
        clearTimeout(timer);
        loop();
      },
      close: () => {
        closed = true;
        clearTimeout(timer);
      },
    };
  }
  /** P1-03: the two faces and the passcode. */
  access() {
    return this.call(api.access.show, {});
  }
  /** P1-03: turn the outside face on / change it (PIN). */
  externalOn(body: ApiBody<typeof api.access.externalOn>, pinGrant: string) {
    return this.call(api.access.externalOn, { body }, { pinGrant });
  }
  /** P1-03: turn the outside face off (no PIN: it narrows who gets in). */
  externalOff() {
    return this.call(api.access.externalOff, {});
  }
  /** P1-03: the passcode mode (PIN). */
  setPasscode(mode: "auto" | "on" | "off", pinGrant: string) {
    return this.call(api.access.passcode, { body: { mode } }, { pinGrant });
  }
  /** P1-03: a one-time link for opening this page from another machine (PIN). */
  openCodeExternal(pinGrant: string) {
    return this.call(api.access.openCodeExternal, {}, { pinGrant });
  }
  /** P5-02 (ADR-144): the relay — chosen, connected, its address and certificate. */
  relay() {
    return this.call(api.relay.relayShow, {});
  }
  /** P5-02: choose a relay (PIN: it lets the world reach the outside face). */
  relaySet(body: ApiBody<typeof api.relay.relaySet>, pinGrant: string) {
    return this.call(api.relay.relaySet, { body }, { pinGrant });
  }
  /** P5-02: stop using the relay (PIN, 5.10: the AI must not quietly cut the owner off). */
  relayOff(pinGrant: string) {
    return this.call(api.relay.relayOff, {}, { pinGrant });
  }
  /** P2-04 (ADR-115): browser origins of external interfaces (outside face only, D-38). */
  uiOrigins() {
    return this.call(api.access.uiOriginsShow, {});
  }
  /** P2-04: replace the allowed external-interface origins (PIN: it lets others in). */
  setUiOrigins(origins: string[], pinGrant: string) {
    return this.call(
      api.access.uiOriginsSet,
      { body: { origins } },
      { pinGrant },
    );
  }
  /** P2-04: allow no external-interface origin (no PIN: it narrows who gets in). */
  clearUiOrigins() {
    return this.call(api.access.uiOriginsClear, {});
  }
  // ── P5-03 (ADR-142): pairing the owner's other devices ─────────────────
  /** P5-03: the paired devices (records only; `all`: revoked / expired too). */
  devices(state: "active" | "all" = "active") {
    return this.call(api.devices.deviceList, { query: { state } });
  }
  /** P5-03: a pairing code for another device (PIN: it lets a device in as the owner). */
  pairDevice(name: string | undefined, pinGrant: string) {
    return this.call(api.devices.pair, { body: name ? { name } : {} }, { pinGrant });
  }
  /** P5-03: revoke a paired device — at once (PIN). */
  revokeDevice(id: string, pinGrant: string) {
    return this.call(api.devices.deviceRevoke, { params: { id } }, { pinGrant });
  }
  /**
   * P5-03: this device trades a pairing code (on the outside face) for its
   * device credential and first session. Sets `token`; keep `secret` on the
   * device (it is not shown again) and trade it with `deviceSession` when
   * the session runs out.
   */
  async redeemPairing(code: string, name?: string) {
    const r = await this.call(api.devices.pairRedeem, { body: { code, ...(name ? { name } : {}) } });
    this.token = r.token;
    return r;
  }
  /** P5-03: a paired device's new session for its credential. Sets `token`. */
  async deviceSession(secret: string) {
    const r = await this.call(api.devices.deviceSession, { body: { secret } });
    this.token = r.token;
    return r;
  }
  /** P5-03: this paired device unpairs itself (no PIN). */
  forgetDevice() {
    return this.call(api.devices.deviceForget, {});
  }
  /** P4-06 (ADR-125): is this session a public agent, can it be made one (no PIN: reading). */
  sessionPublic(id: string) {
    return this.call(api.sessions.publicShow, { params: { id } });
  }
  /** P4-06: make a session public or take it back (PIN: it lets others in). */
  setSessionPublic(id: string, on: boolean, pinGrant: string) {
    return this.call(api.invoke.publicSet, { params: { id }, body: { public: on } }, { pinGrant });
  }
  /**
   * P1-05's PIN. A grant is bound to the credential that asked for it (a
   * web page: its own session) and rides in `daisy-pin-grant` until it
   * expires (`call(def, input, { pinGrant })`).
   */
  pinStatus() {
    return this.call(api.pin.pinStatus, {});
  }
  setPin(pin: string, oldPin?: string) {
    return this.call(api.pin.pinSet, {
      body: { pin, ...(oldPin ? { oldPin } : {}) },
    });
  }
  pinGrant(pin: string) {
    return this.call(api.pin.pinGrant, { body: { pin } });
  }
  /** P1-09: start at boot (`daisy autostart`'s logic, ADR-112 §4). */
  autostart() {
    return this.call(api.settings.autostartStatus, {});
  }
  setAutostart(enabled: boolean) {
    return this.call(api.settings.autostartSet, { body: { enabled } });
  }
  /** P1-02: pending update / restart, and what it waits for (`daisy restart status`). */
  updateStatus() {
    return this.call(api.settings.updateStatus, {});
  }
  restart(mode: "idle" | "now", confirm?: string) {
    return this.call(api.settings.updateRestart, {
      body: { mode, ...(confirm ? { confirm } : {}) },
    });
  }
  cancelRestart() {
    return this.call(api.settings.updateCancel, {});
  }
  catalog() {
    return this.request<Catalog>("/catalog");
  }
  private async filesystem(
    nodeId: string,
    input: {
      operation: "browse" | "ensure";
      path: string;
      offset?: number;
      hidden?: boolean;
    },
  ) {
    const queued = await this.request(
      `/nodes/${encodeURIComponent(nodeId)}/filesystem`,
      "POST",
      input,
    );
    const deadline = Date.now() + 35000;
    while (Date.now() < deadline) {
      const result = await this.request(`/filesystem/${queued.id}`);
      if (result.status === "complete") return result;
      if (result.status === "error")
        throw new DaisyError(400, result.error || said("client.error.filesystemFailed"), "filesystem_failed");
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new DaisyError(504, said("client.error.nodeTimeout"), "node_timeout");
  }
  async browseDirectories(
    nodeId: string,
    path = "",
    offset = 0,
    hidden = false,
  ): Promise<DirectoryListing> {
    return (
      await this.filesystem(nodeId, {
        operation: "browse",
        path,
        offset,
        hidden,
      })
    ).listing;
  }
  async ensureWorkspace(nodeId: string, path: string): Promise<Workspace> {
    return (await this.filesystem(nodeId, { operation: "ensure", path }))
      .workspace;
  }
  /**
   * Own sessions, newest first. `taskId` limits to sessions bound to that host
   * task (`task.id`) or whose messages carried it (`relatedTasks`).
   */
  sessions(opts: { taskId?: string } = {}) {
    return this.call(api.sessions.list, {
      query: opts.taskId ? { taskId: opts.taskId } : {},
    });
  }
  /**
   * A conversation's snapshot. `tail`: newest N items only (`partial`).
   * `since` (+ `from`, the oldest held item): only what changed after that
   * cursor (`delta: true`, see `applySnapshot`); the server answers with a
   * tail snapshot when a delta cannot express it.
   * `view: "conversation"` (+ `messageLimit`, default 20, ≤ 100):
   * a resident answers with its newest visible items only (`view` set in
   * the answer; never a delta); other sessions ignore it.
   */
  snapshot(
    id: string,
    opts: {
      tail?: number;
      since?: number;
      from?: string;
      view?: "conversation";
      messageLimit?: number;
    } = {},
  ) {
    const q = new URLSearchParams();
    if (opts.tail) q.set("tail", String(opts.tail));
    if (opts.since !== undefined) q.set("since", String(opts.since));
    if (opts.from) q.set("from", opts.from);
    if (opts.view) q.set("view", opts.view);
    if (opts.messageLimit !== undefined)
      q.set("messageLimit", String(opts.messageLimit));
    const qs = q.toString();
    return this.request<Snapshot>(`/sessions/${id}${qs ? "?" + qs : ""}`);
  }
  /**
   * Older items before item `before`, oldest first. `view:
   * "conversation"`: a resident's visible items only (limit ≤ 100).
   */
  olderItems(
    id: string,
    before: string,
    limit = 200,
    opts: { view?: "conversation" } = {},
  ) {
    return this.request<ItemsPage>(
      `/sessions/${id}/items?before=${encodeURIComponent(before)}&limit=${limit}` +
        (opts.view ? `&view=${opts.view}` : ""),
    );
  }
  /**
   * Create a session. Pass a `requestId` (e.g. `makeId()` kept for the
   * lifetime of one "create" attempt) and retry with the same value after a
   * network error: the server returns the session it already created with
   * `duplicate: true` instead of creating a second one. Same requestId with
   * different agent/workspace/profile/task is 409 `request_id_conflict`.
   */
  /**
   * New conversation (P1-06: the body's type is the route definition's —
   * `title` blank lets the server name it after the first exchange;
   * `requestId` makes a resend answer the same session).
   */
  create(input: ApiBody<typeof api.sessions.create>) {
    return this.call(api.sessions.create, { body: input });
  }
  /**
   * Send a user message. `context` (optional) is the host page the user is on
   * (fb3 F1): the Agent receives it as `<host_page_context>` before the text,
   * the user item echoes it, and its task refs join `session.relatedTasks`.
   */
  send(
    id: string,
    text: string,
    attachmentIds: string[] = [],
    requestId: string = makeId(),
    delivery: "normal" | "queue" = "normal",
    context?: MessageContextInput | null,
    terminalIds: string[] = [],
  ) {
    return this.request(`/sessions/${id}/messages`, "POST", {
      text,
      attachmentIds,
      requestId,
      delivery,
      ...(context ? { context } : {}),
      ...(terminalIds.length ? { terminalIds } : {}),
    });
  }
  /**
   * 「在终端执行」: run one shell command on the session's node, in
   * its workspace, as the owner's own account. Poll `shellStatus` until
   * `status` is complete / error, then pass the id to `send(…, terminalIds)`.
   */
  shell(sessionId: string, command: string) {
    return this.request<{ id: string; status: string }>(
      `/sessions/${sessionId}/shell`,
      "POST",
      { command },
    );
  }
  shellStatus(id: string) {
    return this.request<TerminalResult & { status: string }>(`/shell/${id}`);
  }
  /**
   * Rename / archive a session, or drop related tasks: `relatedTasks` lists
   * the task ids to keep (others are removed; unknown ids are ignored).
   */
  updateSession(
    id: string,
    patch: {
      title?: string;
      archived?: boolean;
      relatedTasks?: string[];
      /** This conversation's model / effort; "" = the identity's. */
      settings?: SessionSettings;
    },
  ) {
    // The definition's body types `reasoningEffort` as the closed list the
    // server checks; callers still pass `SessionSettings` (a string) —
    // narrowing it is a change for the UI, not for P1-06.
    return this.call(api.sessions.update, {
      params: { id },
      body: patch as ApiBody<typeof api.sessions.update>,
    });
  }
  /**
   * Take a conversation offline: its Agent process is closed (its
   * timers and background work end with it); history stays, the next
   * message brings it back online.
   */
  goOffline(id: string) {
    return this.request<{ ok: true; stopping: boolean }>(
      `/sessions/${id}/offline`,
      "POST",
      {},
    );
  }
  /**
   * What the online Agent's background tasks are doing right now:
   * subagent progress, the end of each background command's / Monitor's
   * output. Read on demand (it is not in the snapshot or the event stream).
   */
  liveActivity(id: string) {
    return this.request<{ at: number | null; items: LiveActivity[] }>(
      `/sessions/${id}/live/activity`,
    );
  }
  /**
   * 「停止」 one item of the 「后台」 list — the Agent's own task
   * (`stoppable`; lands with the Runner's next report, the item shows
   * `stopping` meanwhile) or Daisy's scheduler's (`scheduler:<id>`,
   * cancelled at once; ADR-152: an older server's `source: "harbor"` is
   * given as `"scheduler"`). Owner only.
   */
  async stopBackground(id: string, taskId: string) {
    const r = await this.request<{
      ok: true;
      stopping?: boolean;
      stopped?: boolean;
      source: "agent" | "scheduler";
    }>(
      `/sessions/${id}/background/${encodeURIComponent(taskId)}/stop`,
      "POST",
      {},
    );
    return (r.source as string) === "harbor"
      ? { ...r, source: "scheduler" as const }
      : r;
  }
  /**
   * Daisy's timers and background items of a conversation (open
   * ones first, then the latest ended), and the turns it started itself in
   * the last 24 hours.
   */
  schedules(id: string) {
    return this.request<{
      schedules: DaisySchedule[];
      turnsToday: number;
      /** the zone cron is read in (absent from older control planes). */
      timeZone?: ServerTimeZone;
    }>(`/sessions/${id}/schedules`);
  }
  /** its owner changes an open timer (cron, prompt, label, end / time). */
  updateSchedule(id: string, scheduleId: string, body: ScheduleUpdate) {
    return this.request<{ schedule: DaisySchedule }>(
      `/sessions/${id}/schedules/${scheduleId}`,
      "PATCH",
      body,
    );
  }
  /** its owner adds a timer (wakeup / cron) to a conversation. */
  addSchedule(
    id: string,
    body: Extract<ScheduleCreate, { kind: "wakeup" | "cron" }>,
  ) {
    return this.request<{ schedule: DaisySchedule }>(
      `/sessions/${id}/schedules`,
      "POST",
      body,
    );
  }
  cancelSchedule(id: string, scheduleId: string) {
    return this.request<{ schedule: DaisySchedule }>(
      `/sessions/${id}/schedules/${scheduleId}/cancel`,
      "POST",
      {},
    );
  }
  // P1-01: the resident (常驻 Agent) methods are gone until stage 4
  // rebuilds residents (the old ones are on tag baseline/pre-daisy).
  /** my defaults for my ordinary sessions' prompt (a note, four optional sections). */
  myPrompt() {
    return this.request<MyPromptView>("/me/prompt");
  }
  saveMyPrompt(body: MyPromptUpdate) {
    return this.request<MyPromptView>("/me/prompt", "PUT", body);
  }
  /** what this session really gets as its prompt, layer by layer (its owner only). */
  sessionPrompt(id: string) {
    return this.request<SessionPromptView>(`/sessions/${id}/prompt`);
  }
  /** this ordinary session's own note / switches (null = follow my default). */
  saveSessionPromptExtra(id: string, body: SessionPromptExtraUpdate) {
    return this.request<SessionPromptView>(
      `/sessions/${id}/prompt/extra`,
      "PUT",
      body,
    );
  }
  /** compact this conversation now, so it takes the current prompt text (its owner). */
  applySessionPrompt(id: string) {
    return this.request<SessionPromptView>(
      `/sessions/${id}/prompt/apply`,
      "POST",
      {},
    );
  }
  /** Admins: the layered prompt's switch and what each node read. */
  promptLayerAdmin() {
    return this.request<PromptLayerAdminView>("/admin/prompt-layers");
  }
  savePromptLayerAdmin(body: Partial<Omit<PromptLayerSettings, "epoch">>) {
    return this.request<PromptLayerAdminView>(
      "/admin/prompt-layers",
      "PUT",
      body,
    );
  }
  /**
   * Layered prompt (admins) 「立即生效」, two steps. Without `confirm`: only
   * `estimate` — how many conversations of how many people would be
   * compacted (at most `limit`, default 20, the most recently used) — and
   * its `token`. With `confirm` and that token (good once, for a few
   * minutes, for exactly those conversations): queued. 409 while an
   * earlier one is not finished.
   */
  applyPromptLayersNow(
    body: { confirm?: boolean; limit?: number; token?: string } = {},
  ) {
    return this.request<PromptLayerAdminView>(
      "/admin/prompt-layers/apply-now",
      "POST",
      body,
    );
  }
  /**
   * Layered prompt (admins): drop what an admin's 「立即生效」 queued and has not
   * started (`cancelled`; those already running finish: `stillRunning`).
   * What an owner asked for herself is not touched.
   */
  cancelPromptLayerApply() {
    return this.request<PromptLayerAdminView>(
      "/admin/prompt-layers/apply-cancel",
      "POST",
      {},
    );
  }
  /** Layered prompt (admins): clear what one node reported as the org core. */
  forgetPromptLayerNode(nodeId: string) {
    return this.request<PromptLayerAdminView>(
      `/admin/prompt-layers/nodes/${encodeURIComponent(nodeId)}`,
      "DELETE",
    );
  }
  /** take back my waiting 「立即压缩并生效」 of this session. */
  cancelSessionPromptApply(id: string) {
    return this.request<SessionPromptView>(
      `/sessions/${id}/prompt/apply`,
      "DELETE",
    );
  }
  /**
   * Delete a conversation: its running turn is killed on the
   * runner, then every row of it is purged. `stopping` = a turn was still
   * running when asked (its rows go once it has ended).
   */
  deleteSession(id: string) {
    return this.call(api.sessions.delete, { params: { id } });
  }
  operation(
    id: string,
    name: string,
    args: Record<string, unknown> = {},
    requestId: string = makeId(),
  ) {
    // P1-03: harness configuration is its own route (daisy:manage).
    // Review M-1: opening a terminal too (the outside face's switch).
    const sub = (HARNESS_CONFIG_OPERATIONS as readonly string[]).includes(name)
      ? "/harness"
      : name === "terminal"
        ? "/terminal"
        : "";
    return this.request<{ id: string; sessionId: string }>(
      `/sessions/${id}/operations${sub}`,
      "POST",
      { name, args, requestId },
    );
  }
  operationStatus(sid: string, jid: string) {
    return this.request<{ status: string; result: any }>(
      `/sessions/${sid}/operations/${jid}`,
    );
  }
  /** Add input to the running turn; `context` as in `send`. */
  steer(
    id: string,
    text: string,
    requestId: string = makeId(),
    context?: MessageContextInput | null,
  ) {
    /**
     * `queued` + `reason` — the running turn is someone else's
     * (快速了解, the AI's own, a Daisy wake's): it is a
     * queued message first after it instead (`id` = the job).
     */
    return this.request<{
      id: string;
      status: string;
      queued?: boolean;
      reason?: string;
    }>(`/sessions/${id}/steer`, "POST", {
      text,
      requestId,
      ...(context ? { context } : {}),
    });
  }
  queue(id: string) {
    return this.request<
      {
        id: string;
        text: string;
        status: string;
        jump?: boolean;
        /** not the owner's words — 「群里的协作请求」, a wake … */
        from?: string;
        /** why 「插队发送」 cannot start now (no button then). */
        jumpBlocked?: string;
        /**
         * subagents a jump would have stopped. Now a jump
         * never stops the running turn — no longer sent (older servers).
         */
        runningSubagents?: number;
        /**
         * delivered into the running turn through the agent's own
         * input queue, not read yet (「已追加，等待 AI 读取」, `appendLabel`);
         * `appendState` "withdrawing" after 「移除」; `appendAuto`: a Daisy
         * wake Daisy appended by itself. Listed first, no 插队 button.
         * a row the agent has read is not listed (part of the
         * running turn); a waiting one is 「撤回」-able, never merged.
         */
        appended?: boolean;
        appendState?: "waiting" | "withdrawing";
        appendLabel?: string;
        appendAuto?: boolean;
        /** queued messages merged into this one. */
        merged?: number;
        /** the owner's own plain text — 「合并追加」 can take it. */
        steerable?: boolean;
        /**
         * a turn runs and the agent's own input queue takes this
         * row as it is — 「合并追加」 can put it in natively.
         */
        appendable?: boolean;
        /**
         * sent while a turn runs — whether 「合并追加」 takes this
         * row into it (her text that fits the turn, or `appendable`).
         */
        steerIn?: boolean;
        /**
         * jumped, but could not go in with the jump ahead of it —
         * it runs in a later turn (show 「下一轮发出（来源不同）」).
         */
        nextTurn?: boolean;
        /** why it could not merge (absent: it just waits its turn). */
        nextTurnWhy?: string;
        /**
         * "paused" (nothing runs; 「继续」 sends it) or
         * "stopping" (the running turn is being stopped; then paused).
         */
        nextTurnWait?: "paused" | "stopping";
        /**
         * Daisy wakes carried by this message, each with its own
         * text (≤ 4000 characters, `truncated` when cut); `text` is the
         * queued text in full.
         */
        carriedItems?: {
          id: string;
          from?: string;
          text: string;
          truncated?: boolean;
        }[];
      }[]
    >(`/sessions/${id}/queue`);
  }
  resumeQueue(id: string) {
    return this.request(`/sessions/${id}/queue/resume`, "POST", {});
  }
  /**
   * `withdrawing` — an appended row the agent holds is being
   * asked back (Claude cancel_async_message); its bubble then says.
   */
  removeQueued(id: string, jid: string) {
    return this.request<{ ok: true; withdrawing?: boolean }>(
      `/sessions/${id}/queue/${jid}`,
      "DELETE",
    );
  }
  /**
   * 「插队发送」 a queued message (contracts QueueJumpResult).
   * never stops the running turn — `appended` into it natively
   * (read at its next tool boundary), else `next` (first after it, with
   * the reason); nothing running → `started`.
   */
  jumpQueued(id: string, jid: string) {
    return this.request<QueueJumpResult>(
      `/sessions/${id}/queue/${jid}/jump`,
      "POST",
      {},
    );
  }
  /**
   * 「合并插队」: the selected queued messages (or `all`), in queue
   * order, merged into one and jumped (contracts QueueMergeJumpResult).
   */
  mergeJumpQueued(id: string, pick: { ids: string[] } | { all: true }) {
    return this.request<QueueMergeJumpResult>(
      `/sessions/${id}/queue/merge-jump`,
      "POST",
      pick,
    );
  }
  /**
   * 「批量移除」: the selected queued rows (or every row still
   * waiting), each as its own 移除 / 撤回 (contracts QueueRemoveResult).
   */
  removeQueuedMany(id: string, pick: { ids: string[] } | { all: true }) {
    return this.request<QueueRemoveResult>(
      `/sessions/${id}/queue/remove`,
      "POST",
      pick,
    );
  }
  /**
   * 「合并追加」: steerable text → one 立即追加 into the running
   * turn; other `appendable` rows appended natively, the rest
   * stay queued (`left`).
   */
  mergeSteerQueued(id: string, pick: { ids: string[] } | { all: true }) {
    return this.request<QueueMergeSteerResult>(
      `/sessions/${id}/queue/merge-steer`,
      "POST",
      pick,
    );
  }
  cancel(id: string) {
    return this.call(api.sessions.cancel, { params: { id } });
  }
  /**
   * Answer a harness approval from its conversation. A permission prompt
   * is decided through the unified inbox's route (`respondApproval`, only
   * its owner may use it; D-39): the conversation's route answers
   * it 409 approval_elsewhere, so an older caller that still posts there
   * falls back to the inbox too. Questions stay on the conversation route.
   */
  async approve(
    id: string,
    aid: string,
    optionId: string,
    answers?: Record<string, string>,
  ) {
    try {
      return await this.request(`/sessions/${id}/approvals/${aid}`, "POST", {
        optionId,
        answers,
      });
    } catch (e: any) {
      if (e?.status !== 409 || e?.code !== "approval_elsewhere") throw e;
      return this.respondApproval("perm:" + aid, optionId);
    }
  }
  /**
   * POST /api/approvals/:id/respond — decide one card of the 「审批」 page
   * (`perm:<id>` a harness permission prompt, `ask:` / `block:` …). The
   * conversation's permission card uses the same call (D-39), so whichever
   * answers first wins and the other sees it decided (409 when different).
   */
  respondApproval(id: string, decision: string, note?: string) {
    return this.call(api.approvals.respond, {
      params: { aid: id },
      body: { decision, ...(note?.trim() ? { note: note.trim() } : {}) },
    });
  }
  upload(name: string, mime: string, data: string) {
    return this.call(api.attachments.upload, { body: { name, mime, data } });
  }
  async attachment(a: Attachment) {
    const r = await this.fetchImpl(`${this.baseUrl}/api/attachments/${a.id}`, {
      headers: this.authHeaders(await this.credential()),
    });
    if (!r.ok) throw new DaisyError(r.status, said("client.error.attachmentFailed"), "attachment_unreadable");
    return r.blob();
  }
  /**
   * Snapshot is canonical. WS accelerates updates; polling also recovers
   * missed wakeups. Delivers the whole conversation (first a full snapshot,
   * then only what changed, merged); `watchSession` is the windowed form.
   */
  watch(
    id: string,
    onData: (s: Snapshot) => void,
    onConnection?: (s: "live" | "reconnecting" | "offline") => void,
    onError?: (e: Error) => void,
  ) {
    const w = this.watchSession(
      id,
      { data: (s) => onData(s), connection: onConnection, error: onError },
      { tail: 0 },
    );
    return () => w.close();
  }
  /**
   * Follow one conversation. Fetching and knowing what is stale are
   * two things: the live socket announces each new version (`changed` +
   * cursor) and `version` reports it at once; fetching then asks only for
   * what changed since the held cursor (`?since=`), merged by
   * `applySnapshot`. The first fetch is the newest `tail` items (0 = all),
   * or a delta from `initial` (a cached snapshot shown meanwhile). Polling
   * is the fallback: every `pollMs` without the socket, every `livePollMs`
   * with it. `data` gets every merged view and when the server confirmed it.
   * A dead connection is noticed without waiting for the poll: the socket is
   * pinged every `pingMs` and given `pongMs` to answer, and the browser's
   * `offline` event (or `navigator.onLine === false`) counts at once — then
   * the view is offline (`connection`, `error`) and the socket reconnects.
   */
  watchSession(
    id: string,
    h: SessionWatchHandlers,
    opts: {
      initial?: Snapshot | null;
      tail?: number;
      pollMs?: number;
      livePollMs?: number;
      pingMs?: number;
      pongMs?: number;
    } = {},
  ): SessionWatch {
    const tail = opts.tail ?? 120,
      pollMs = opts.pollMs ?? 4000,
      livePollMs = opts.livePollMs ?? 15000,
      pingMs = opts.pingMs ?? 10000,
      pongMs = opts.pongMs ?? 5000;
    let closed = false,
      busy = false,
      dirty = false,
      subscribed = false,
      ws: WebSocket | undefined,
      retry: any,
      attempt = 0,
      lastOk = 0,
      /** Fetches started so far (a catch-up must have started after `ready`). */
      fetches = 0,
      /**
       * Subscribed, not yet caught up: "live" waits for a fetch started after
       * `ready` whose answer holds at least the cursor `ready` reported.
       */
      catchUp: { from: number; cursor: number } | null = null,
      state: "live" | "reconnecting" | "offline" | "" = "",
      /**
       * P2-04: the last socket closed with 1008 (its credential expired or
       * was refused): ask `credentials` for a new one before subscribing.
       */
      renew: string | null = null,
      held: Snapshot | null =
        opts.initial && opts.initial.session.id === id ? opts.initial : null;
    /** First retry ~250 ms (a server reload pauses ~0.4 s), then back off. */
    const reconnectIn = () =>
      Math.min(5000, 250 * 2 ** attempt++) + Math.random() * 250;
    const connection = (next: "live" | "reconnecting" | "offline") => {
      if (closed || next === state) return;
      state = next;
      h.connection?.(next);
    };
    const refresh = async () => {
      if (closed) return;
      if (busy) {
        dirty = true;
        return;
      }
      busy = true;
      const seq = ++fetches;
      try {
        const first = held?.items[0]?.id;
        const next = await this.snapshot(
          id,
          held
            ? {
                since: held.cursor,
                ...(tail ? { tail } : {}),
                ...(first ? { from: first } : {}),
              }
            : { tail },
        );
        if (closed) return;
        lastOk = Date.now();
        const merged = applySnapshot(held, next);
        if (!merged) {
          // The window no longer matches the server (rewound): reload it.
          held = null;
          dirty = true;
        } else if (next.reset || !held || merged.cursor >= held.cursor) {
          // `reset`: the server's log is behind the held cursor (restored
          // from a backup): its answer replaces everything held.
          held = merged;
          h.data(held, { at: lastOk, ...(next.reset ? { reset: true } : {}) });
        }
        // Live = subscribed and caught up with what `ready` reported.
        if (
          catchUp &&
          held &&
          seq >= catchUp.from &&
          held.cursor >= catchUp.cursor
        )
          catchUp = null;
        connection(subscribed && !catchUp ? "live" : "reconnecting");
      } catch (e) {
        if (!closed) {
          connection("offline");
          h.error?.(e as Error);
        }
      } finally {
        busy = false;
        if (dirty && !closed) {
          dirty = false;
          void refresh();
        }
      }
    };
    let pongTimer: any;
    /** The connection is gone (no pong, or the browser went offline). */
    const lost = (why: string) => {
      if (closed) return;
      clearTimeout(pongTimer);
      pongTimer = undefined;
      const socket = ws;
      ws = undefined;
      if (socket) {
        socket.onclose = null;
        socket.onerror = null;
        socket.onmessage = null;
        try {
          socket.close();
        } catch {
          /* already closing */
        }
      }
      subscribed = false;
      catchUp = null;
      connection("offline");
      h.error?.(new Error(why));
      clearTimeout(retry);
      retry = setTimeout(connect, reconnectIn());
    };
    const connect = () => {
      if (closed) return;
      subscribed = false;
      catchUp = null;
      if (state !== "offline") connection("reconnecting");
      try {
        const WS = this.opts.WebSocket ?? WebSocket;
        const socket = (ws = new WS(
          this.baseUrl.replace(/^http/, "ws") + "/api/live",
        ));
        let sent = "";
        socket.onopen = () =>
          void (async () => {
            // P2-04: the credential now (a provider may have renewed it).
            const used = renew;
            renew = null;
            const token =
              used !== null
                ? await this.renewed(used)
                : await this.credential();
            if (closed || ws !== socket) return;
            sent = token;
            socket.send(
              JSON.stringify({
                type: "subscribe",
                sessionId: id,
                // P1-03: the first frame carries the credential (no other way in).
                ...(token ? { token } : {}),
              }),
            );
          })().catch((e) => {
            // No credential to be had: this attempt fails like a dropped one.
            if (closed || ws !== socket) return;
            h.error?.(e as Error);
            try {
              socket.close();
            } catch {
              /* already closing */
            }
          });
        socket.onmessage = (e) => {
          // Anything from the server proves the connection alive.
          clearTimeout(pongTimer);
          pongTimer = undefined;
          let f: any = null;
          try {
            f = JSON.parse(String(e.data));
          } catch {
            /* not a frame of ours */
          }
          if (f?.type === "ready") {
            // Subscribed: catch up on what happened before (a small delta);
            // "live" only once that answer is in (the view stays 正在同步…
            // meanwhile). An older server sends no cursor: any catch-up.
            subscribed = true;
            attempt = 0;
            const cursor = Number(f.cursor);
            const known = Number.isFinite(cursor) ? cursor : -1;
            catchUp = { from: fetches + 1, cursor: known };
            if (held && known > held.cursor) h.version?.(known);
            void refresh();
          } else if (f?.type === "changed") {
            const cursor = Number(f.cursor);
            if (!held || !(cursor <= held.cursor)) {
              if (Number.isFinite(cursor)) h.version?.(cursor);
              void refresh();
            } else if (f.touched) {
              // The session record changed without an event (title,
              // settings): an empty delta brings the new one.
              void refresh();
            }
          }
        };
        // Closed or failed (a server reload closes with 1012): not live
        // from this moment; reconnect soon, then back off.
        const down = () => {
          if (closed || ws !== socket) return;
          ws = undefined;
          clearTimeout(pongTimer);
          pongTimer = undefined;
          subscribed = false;
          catchUp = null;
          if (state !== "offline") connection("reconnecting");
          clearTimeout(retry);
          retry = setTimeout(connect, reconnectIn());
        };
        socket.onerror = down;
        socket.onclose = (e: { code?: number }) => {
          // 1008: the server refused or ended this credential (expired,
          // logged out, issuer changed) — the next attempt renews it.
          // P6-26 (P5N-6): 4401, this paired device was revoked. Either
          // way the credential is asked for now, on the close itself — not
          // after the reconnect timer, which a browser holds back for up
          // to a minute in a background page. Refused: the view hears it
          // (`error`, a 401 — it drops what it shows) and the provider's
          // owner (a paired device's page) leaves for its login screen.
          const code = e?.code;
          if (
            (code === LIVE_CLOSE.credential || code === LIVE_CLOSE.deviceRevoked) &&
            this.opts.credentials &&
            !closed &&
            ws === socket
          ) {
            renew = sent;
            const used = sent;
            void this.renewed(used).catch((err) => {
              if (!closed) h.error?.(err as Error);
            });
          }
          down();
        };
      } catch {
        retry = setTimeout(connect, reconnectIn());
      }
    };
    // The browser knows first when the network is gone (web only).
    const g = globalThis as any;
    const onOffline = () => lost(said("client.live.offline"));
    const onOnline = () => {
      void refresh();
      if (!ws) {
        clearTimeout(retry);
        connect();
      }
    };
    if (typeof g.addEventListener === "function") {
      g.addEventListener("offline", onOffline);
      g.addEventListener("online", onOnline);
    }
    // P6-27 (P5N-8): back from the background — catch up, and check the
    // socket now instead of on timers the browser held back.
    const wake = () => {
      if (closed) return;
      attempt = 0;
      void refresh();
      if (!ws) {
        clearTimeout(retry);
        connect();
      } else if (ws.readyState === 1 && !pongTimer) {
        try {
          ws.send(JSON.stringify({ type: "ping" }));
          pongTimer = setTimeout(() => lost(said("client.live.noPong")), pongMs);
        } catch {
          lost(said("client.live.noPong"));
        }
      }
    };
    this.wakers.add(wake);
    connect();
    if (g.navigator?.onLine === false) lost(said("client.live.offline"));
    void refresh();
    const poll = setInterval(() => {
      if (
        !subscribed ||
        state === "offline" ||
        Date.now() - lastOk >= livePollMs
      )
        void refresh();
    }, pollMs);
    const ping = setInterval(() => {
      if (ws?.readyState !== 1 || pongTimer) return;
      ws.send(JSON.stringify({ type: "ping" }));
      pongTimer = setTimeout(() => lost(said("client.live.noPong")), pongMs);
    }, pingMs);
    return {
      close: () => {
        closed = true;
        this.wakers.delete(wake);
        clearInterval(poll);
        clearInterval(ping);
        clearTimeout(retry);
        clearTimeout(pongTimer);
        if (typeof g.removeEventListener === "function") {
          g.removeEventListener("offline", onOffline);
          g.removeEventListener("online", onOnline);
        }
        ws?.close();
      },
      refresh: () => void refresh(),
      older: async (limit = 200) => {
        const now = held;
        const first = now?.items[0]?.id;
        if (!now || !now.partial || !first) return false;
        try {
          const page = await this.olderItems(id, first, limit);
          // A delta may have landed meanwhile: the page still goes in front
          // as long as the window starts where it did.
          const cur = held;
          if (closed || !cur || cur.items[0]?.id !== first) return !closed;
          held = {
            ...cur,
            items: [...page.items, ...cur.items],
            partial: page.more,
          };
          h.data(held, { at: lastOk });
          return page.more;
        } catch (e) {
          if (e instanceof DaisyError && e.status === 409 && !closed) {
            held = null;
            void refresh();
          }
          throw e;
        }
      },
    };
  }
}
export interface SessionWatchHandlers {
  /**
   * Every newer view of the conversation; `at` = when the server confirmed
   * it; `reset` = it replaces everything held (the server's log went back).
   */
  data: (s: Snapshot, info: { at: number; reset?: boolean }) => void;
  /** The server announced a newer version than the one held (it is stale). */
  version?: (cursor: number) => void;
  connection?: (state: "live" | "reconnecting" | "offline") => void;
  error?: (e: Error) => void;
}
export interface SessionWatch {
  close(): void;
  /** Fetch what changed now. */
  refresh(): void;
  /** Page in older items before the held window; resolves whether more remain. */
  older(limit?: number): Promise<boolean>;
}
/**
 * Apply a snapshot answer to the held view. A complete answer
 * (full or tail) replaces it. A delta (`?since=`) replaces held items by id
 * — unchanged ones keep their objects — and appends new ones; the held
 * window keeps its extent. null = the delta does not fit (nothing held, or
 * items were deleted: the server's total disagrees): fetch a complete one.
 * An answer older than the held view returns the held view.
 */
export function applySnapshot(
  held: Snapshot | null,
  next: Snapshot,
): Snapshot | null {
  if (!next.delta) {
    // A reset (the server's log is behind the held cursor) always replaces.
    if (
      !next.reset &&
      held &&
      held.session.id === next.session.id &&
      next.cursor < held.cursor
    )
      return held;
    return next;
  }
  if (!held || held.session.id !== next.session.id) return null;
  if (next.cursor < held.cursor) return held;
  const index = new Map(held.items.map((x, i) => [x.id, i]));
  let items = held.items;
  const added: Item[] = [];
  for (const it of next.items) {
    const i = index.get(it.id);
    if (i === undefined) added.push(it);
    else {
      if (items === held.items) items = items.slice();
      items[i] = it;
    }
  }
  if (
    next.total !== undefined &&
    held.total !== undefined &&
    held.total + added.length !== next.total
  )
    return null;
  if (added.length) items = [...items, ...added];
  const { delta: _delta, ...rest } = next;
  return {
    ...rest,
    items,
    partial: held.partial,
    total: next.total ?? held.total,
  };
}
/**
 * An idempotency key / request id. `crypto.randomUUID` exists only in a
 * secure context: over plain HTTP on a network address (the outside face
 * without TLS, docs/WEB-ORIGINS.md) a v4 UUID is made from
 * `crypto.getRandomValues`, which every context has.
 */
export function makeId() {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  if (c?.getRandomValues) {
    const b = c.getRandomValues(new Uint8Array(16));
    b[6] = (b[6]! & 0x0f) | 0x40;
    b[8] = (b[8]! & 0x3f) | 0x80;
    const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

/** P2-04: `followNotifications`' callbacks. */
export interface NotificationFollowHandlers {
  /** New or changed notifications, and the cursor that now covers them. */
  items: (
    items: NotificationsPage["items"],
    cursor: number,
  ) => void | Promise<void>;
  error?: (e: Error) => void;
}
/** P2-03: `followEvents`' callbacks. */
export interface EventFollowHandlers {
  /**
   * A page of events (oldest first) and the cursor that now covers them;
   * `snapshot`: the open cards at the start or after a reset.
   */
  events: (
    events: DaisyEvent[],
    cursor: number,
    info: { snapshot: boolean },
  ) => void | Promise<void>;
  /** The cursor could not go on (410 cursor_reset): a snapshot follows. */
  reset?: (cursor: number) => void;
  error?: (e: Error) => void;
}
/** P2-04: a follower of a cursor-paged feed (notifications; P2-03's events). */
export interface CursorFollow {
  /** The cursor held now (everything up to it was handed to `items`). */
  cursor(): number;
  /** Read now instead of waiting for the next poll. */
  refresh(): void;
  close(): void;
}

/** P2-04: one Daisy of a `DaisyConnections`. */
export interface DaisyConnectionSpec extends DaisyClientOptions {
  /** The caller's name for this Daisy (unique in the set). */
  id: string;
  /** Its address: the local face (same machine) or the outside face. */
  baseUrl: string;
  /** A fixed credential instead of `credentials` (or the set's default). */
  token?: string;
}
/** P2-04: what is known about one connection. */
export interface DaisyConnectionState {
  id: string;
  baseUrl: string;
  /** null: nothing asked yet; true: its last request was answered; false: it was not. */
  reachable: boolean | null;
  lastOk: number | null;
  lastError: string | null;
}
/** P2-04: one connection's outcome in `DaisyConnections.each`. */
export type EachResult<T> =
  { id: string; ok: true; value: T } | { id: string; ok: false; error: Error };

/**
 * P2-04 (ADR-115): several Daisys at once — an interface's backend (a Node
 * process) holding one external issuer's token for the owner and working
 * on each of the owner's Daisys. Each connection is its own `DaisyClient`
 * — its own address, credentials, live sockets and cursors; one that is
 * down never holds up or breaks another (`each` settles every one).
 *
 * ```ts
 * const daisys = new DaisyConnections({ credentials: ({ refresh }) => issuerToken(refresh) });
 * daisys.add({ id: "laptop", baseUrl: "https://laptop.tail:29601", fetch: pinnedFetch });
 * daisys.add({ id: "desktop", baseUrl: "http://127.0.0.1:29215" });
 * const lists = await daisys.each((c) => c.sessions());
 * ```
 */
export class DaisyConnections {
  private conns = new Map<
    string,
    {
      client: DaisyClient;
      state: DaisyConnectionState;
      closers: Set<() => void>;
    }
  >();
  /** `defaults` apply to every connection (a shared `credentials`, say). */
  constructor(private defaults: DaisyClientOptions = {}) {}

  /** Add one Daisy; its client. */
  add(spec: DaisyConnectionSpec): DaisyClient {
    const { id, baseUrl, token, ...own } = spec;
    if (!id) throw new ClientError("connection_id_missing", "client.connections.idMissing");
    if (this.conns.has(id)) throw new ClientError("connection_exists", "client.connections.exists", { id });
    const state: DaisyConnectionState = {
      id,
      baseUrl: baseUrl.replace(/\/$/, ""),
      reachable: null,
      lastOk: null,
      lastError: null,
    };
    const opts: DaisyClientOptions = { ...this.defaults, ...own, id };
    // A fixed token for this one overrides a shared provider.
    if (token !== undefined && own.credentials === undefined)
      delete opts.credentials;
    const told = opts.onReachability;
    opts.onReachability = (reachable, error) => {
      state.reachable = reachable;
      if (reachable) state.lastOk = Date.now();
      else
        state.lastError = String(
          (error as Error)?.message ?? error ?? "",
        ).slice(0, 300);
      told?.(reachable, error);
    };
    const client = new DaisyClient(baseUrl, token ?? "", opts);
    this.conns.set(id, { client, state, closers: new Set() });
    return client;
  }
  has(id: string) {
    return this.conns.has(id);
  }
  /** The client of `id` (throws when there is none). */
  get(id: string): DaisyClient {
    const c = this.conns.get(id);
    if (!c) throw new ClientError("connection_not_found", "client.connections.notFound", { id });
    return c.client;
  }
  ids(): string[] {
    return [...this.conns.keys()];
  }
  state(id: string): DaisyConnectionState {
    const c = this.conns.get(id);
    if (!c) throw new ClientError("connection_not_found", "client.connections.notFound", { id });
    return { ...c.state };
  }
  states(): DaisyConnectionState[] {
    return [...this.conns.values()].map((c) => ({ ...c.state }));
  }
  /**
   * Run `fn` on every connection at once; every one settles (a Daisy that
   * is down is an `ok: false` entry, the others are unaffected).
   */
  async each<T>(
    fn: (client: DaisyClient, id: string) => Promise<T>,
    ids: readonly string[] = this.ids(),
  ): Promise<EachResult<T>[]> {
    return Promise.all(
      ids.map(async (id): Promise<EachResult<T>> => {
        try {
          return { id, ok: true, value: await fn(this.get(id), id) };
        } catch (e) {
          return {
            id,
            ok: false,
            error: e instanceof Error ? e : new Error(String(e)),
          };
        }
      }),
    );
  }
  /** Follow a conversation on one Daisy (closed with it on `remove` / `close`). */
  watchSession(
    id: string,
    sessionId: string,
    h: SessionWatchHandlers,
    opts?: Parameters<DaisyClient["watchSession"]>[2],
  ): SessionWatch {
    const w = this.get(id).watchSession(sessionId, h, opts);
    return this.track(id, w);
  }
  /** Follow one Daisy's notifications from its own cursor. */
  followNotifications(
    id: string,
    h: NotificationFollowHandlers,
    opts?: Parameters<DaisyClient["followNotifications"]>[1],
  ): CursorFollow {
    const f = this.get(id).followNotifications(h, opts);
    return this.track(id, f);
  }
  /** P2-03: follow one Daisy's event outlet from its own cursor. */
  followEvents(
    id: string,
    h: EventFollowHandlers,
    opts?: Parameters<DaisyClient["followEvents"]>[1],
  ): CursorFollow {
    const f = this.get(id).followEvents(h, opts);
    return this.track(id, f);
  }
  private track<W extends { close(): void }>(id: string, w: W): W {
    const c = this.conns.get(id)!;
    const close = w.close.bind(w);
    const closer = () => close();
    c.closers.add(closer);
    w.close = () => {
      c.closers.delete(closer);
      close();
    };
    return w;
  }
  /** Drop one Daisy: its watches and followers stop. */
  remove(id: string) {
    const c = this.conns.get(id);
    if (!c) return;
    for (const close of [...c.closers]) close();
    c.closers.clear();
    c.client.forgetCached();
    this.conns.delete(id);
  }
  /** Drop every one. */
  close() {
    for (const id of this.ids()) this.remove(id);
  }
}
