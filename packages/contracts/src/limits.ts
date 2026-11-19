/**
 * docs/contracts/limits.md: every time limit and bound, written once.
 * The server, the command line and the web page read them from here;
 * nothing else spells these numbers out. (P1-05 starts the module with
 * §6's PIN rows; the other sections join it as their packages land.)
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** limits.md §1 (cards and authorization). */
export const CARD_LIMITS = {
  /**
   * A harness's tool permission or question card nobody answers expires
   * this long after it was raised: its turn ends as an interruption (not
   * replayed), the card shows 已过期 and an answer is refused (R-4, Q-1).
   * The owner may change it (DAISY_CARD_TTL_HOURS).
   */
  toolCardTtlMs: 24 * HOUR,
  /**
   * P4-03 (总纲 5.6 「卡片七天没人处理就过期」, limits.md §1): a call card —
   * someone wants to call one of my agents — nobody answers expires this
   * long after it was raised; the calls waiting on it are refused.
   */
  callCardTtlMs: 7 * 24 * HOUR,
  /**
   * P4-03 (limits.md §1 「被拒绝后…冷却」, 5.6 「拒绝…不会重试」): after the
   * owner refuses a call card, the same person's calls to the same agent
   * are refused outright (no new card) for this long.
   */
  callCooldownMs: 10 * MINUTE,
  /**
   * P4-03 review M-3: calls of one person to one agent that may wait on
   * one card at a time; more are refused outright (no card).
   */
  callCardMaxWaiting: 16,
  /**
   * P4-03 review L-2: pending call cards at most, in all and from one
   * external issuer's people together; beyond, calls are refused outright
   * (no card) — a flood cannot push genuine cards out of the 「审批」 list
   * (it shows the newest 200).
   */
  callCardsPendingMax: 200,
  callCardsPendingPerIssuer: 50,
} as const;

/** limits.md §6 (PIN), ADR-099 recommendation 5, D-32. */
export const PIN_LIMITS = {
  /** D-32: at least 6 characters; digits only is allowed. */
  minLength: 6,
  /** A bound so a request cannot make the server hash megabytes. */
  maxLength: 128,
  /** A PIN grant lives this long after it is issued (limits.md §6). */
  grantTtlMs: 5 * MINUTE,
  /** Consecutive wrong PINs that lock entry (each round). */
  attemptsPerRound: 5,
  /**
   * How long each lock lasts, by round: 15 min, then 1 h, then doubling
   * (2 h, 4 h, …) up to `lockMaxMs`. One right PIN clears the rounds.
   */
  lockFirstMs: 15 * MINUTE,
  lockSecondMs: HOUR,
  lockMaxMs: 24 * HOUR,
  /**
   * The scrypt cost of a new verifier (ADR-099: N = 2^17, r = 8, p = 1,
   * 16-byte salt; about 128 MiB and 0.2–0.5 s). Stored with each verifier,
   * so raising these upgrades old ones on their next right entry.
   */
  scrypt: { log2N: 17, r: 8, p: 1, saltBytes: 16, keyBytes: 32 },
} as const;

/** How long the lock of the `round`-th full round of wrong PINs lasts (round ≥ 1). */
export function pinLockMs(round: number): number {
  const L = PIN_LIMITS;
  if (round <= 1) return L.lockFirstMs;
  if (round === 2) return L.lockSecondMs;
  return Math.min(L.lockMaxMs, L.lockSecondMs * 2 ** Math.min(round - 2, 32));
}

/**
 * limits.md §5 (tokens): P2-01's external issuer (token.md §4.2) and
 * P2-02's tokens fetched for an AI (token.md §6, X-4).
 */
export const TOKEN_LIMITS = {
  /** Clock skew allowed on `exp` / `iat` / `nbf` (seconds). */
  clockSkewS: 60,
  /**
   * D-38 (stage-2 gate): a token from the external issuer that asserts the
   * owner (`sub` = the configured owner subject) is refused when its
   * lifetime `exp - iat` is longer than this (seconds). Exactly 24 h is
   * accepted; one second more is not. An owner token always carries `iat`
   * (it is a required claim of every access token, so one without it is
   * refused before this bound is looked at). No clock skew is added: the
   * bound is on the token's own two claims, not on this machine's clock.
   */
  externalOwnerMaxS: 24 * 3600,
  /** 3.7: a token for an AI lives at most an hour (seconds). */
  aiTokenMaxS: 3600,
  /** A cached token for an AI is fetched again when this little is left (seconds). */
  aiTokenRenewS: 300,
  /** Review L-3: tokens kept per session (the soonest to expire are dropped first). */
  aiTokensPerSession: 16,
  /** Review L-3: new tokens fetched per session per minute (more: 429). */
  aiTokenFetchesPerMinute: 10,
  /**
   * P4-01 (token.md §5, limits.md §5): a cross-Daisy access token (`a2a`,
   * signed by a contact for this Daisy) lives at most this long (seconds).
   * A longer one is refused; it is signed afresh for each request.
   */
  a2aMaxS: 300,
  /**
   * P4-12 (token.md §5, §7; limits.md §5): `daisy token` — a token for a
   * third-party A2A client lives this long unless asked otherwise, and at
   * most `visitorMaxS`; at least `visitorMinS` (seconds).
   */
  visitorDefaultS: 7 * 24 * 3600,
  visitorMaxS: 90 * 24 * 3600,
  visitorMinS: 60,
  /** P4-12: tokens for third-party clients in force at once (more: 409 `too_many_tokens`). */
  visitorActiveMax: 200,
  /** P4-12: a token's 「最近一次使用」 is written at most this often (ms). */
  visitorTouchMs: 60_000,
  /** The self-signed actor token (RFC 8693) and client assertion (RFC 7523) live this long (seconds). */
  assertionS: 300,
  /** The issuer's JWKS is cached by its Cache-Control max-age, else this long. */
  jwksDefaultMs: HOUR,
  /** …but never shorter or longer than these (a `no-store` reads as the shortest). */
  jwksMinMs: 5 * MINUTE,
  jwksMaxMs: 24 * HOUR,
  /**
   * Review M-2: a cache past its lifetime that cannot be refetched is still
   * used for this long; after that every token is refused until the issuer
   * answers again. (Default 24 h — the owner may tune it.)
   */
  jwksMaxStaleMs: 24 * HOUR,
  /** An unknown `kid`, or an expired cache: the JWKS is fetched at most once per this. */
  jwksRefetchMs: MINUTE,
  /** One request to the issuer (metadata, JWKS, token exchange) gives up after this. */
  fetchTimeoutMs: 5_000,
  /** The most an answer from the issuer may be (bytes). */
  fetchMaxBytes: 256 * 1024,
  /** The most keys kept from one JWKS. */
  jwksMaxKeys: 64,
  /** The smallest RSA key accepted (bits). */
  rsaMinBits: 2048,
} as const;

/**
 * limits.md §7 (事件与读取), docs/contracts/events.md (P2-03): the event
 * outlet. Nobody subscribing changes nothing: events are written all the
 * same and go after `retentionMs` — except an open card's 「出现」 event,
 * kept until the card is resolved.
 */
export const EVENT_LIMITS = {
  /** limits.md §7 「事件保留」: 30 days (建议). */
  retentionMs: 30 * 24 * HOUR,
  /** limits.md §7 「事件每页最多」: 200; also the default page. */
  pageMax: 200,
  /** limits.md §7 「长轮询最长等待」: 30 s (建议). */
  waitMaxS: 30,
  /** limits.md §7 「事件标题长度」: 200 characters (建议). */
  titleMax: 200,
  /** Long polls waiting at once; the next one is answered at once, empty (建议). */
  waitersMax: 64,
  /** How often the outbox is swept for expired events. */
  sweepEveryMs: HOUR,
} as const;

/**
 * limits.md §8 (身份名片), docs/contracts/identity-card.md (P4-01).
 */
export const IDENTITY_CARD_LIMITS = {
  /** The owner's display name: 1–64 characters (建议). */
  nameMax: 64,
  /** A note: at most 200 characters (建议). */
  noteMax: 200,
  /** When checking an identity number by voice, at least this many characters (80 bits, 建议). */
  verifyChars: 16,
  /** Addresses on one card (P4-01, 建议). */
  addrsMax: 8,
  /** One address URL (P4-01, 建议). */
  urlMax: 2048,
  /**
   * Review L-1: a card's `iat` may be at most this far in the future
   * (seconds; clocks differ). Further would lock out every later update
   * of that contact (an older card never replaces a newer).
   */
  iatFutureMaxS: 24 * 3600,
  /** The whole text handed to import (bytes, P4-01, 建议): a card is ~600 characters. */
  textMax: 16 * 1024,
} as const;

/**
 * limits.md §2 (A2A 对话), a2a-usage.md §6 / §7 / §12, trace.md §5 (P4-04,
 * ADR-123). The A2A server (packages/daisy/src/a2a/) reads these; P4-08's
 * client the trace ones.
 */
export const A2A_LIMITS = {
  /** A visiting conversation idle this long is reclaimed (总纲 5.8 / 12.1 建议 7 天). */
  contextIdleMs: 7 * 24 * HOUR,
  /** How often idle conversations are looked for. */
  sweepEveryMs: HOUR,
  /** `messageId` length (characters). */
  messageIdMin: 8,
  messageIdMax: 100,
  /** `contextId` / `taskId` / a referenced task id (longer ones are never ours). */
  idMax: 200,
  /** Parts per message. */
  partsMax: 16,
  /** One text part (characters); a `data` part as JSON counts the same. */
  textMax: 50_000,
  /** One file part (bytes, decoded). */
  fileMax: 12 * 1024 * 1024,
  /** File parts per message. */
  filesMax: 8,
  /** Files returned inline in a result: each / all together (bytes); over that, left out and said so. */
  resultFileMax: 12 * 1024 * 1024,
  resultFilesMax: 32 * 1024 * 1024,
  /** Referenced tasks per message. */
  referencesMax: 16,
  /** A file part's name / media type (characters). */
  filenameMax: 250,
  mediaTypeMax: 150,
  /** A task's `history` when `historyLength` is not given / the most ever returned. */
  historyDefault: 100,
  historyMax: 1000,
  /** ListTasks page size: default / most. */
  pageDefault: 50,
  pageMax: 100,
  /**
   * P4-04 review M-1 / L-5 / L-6: what one caller may make this Daisy hold.
   * `metadataMax`: a message's `metadata`, and each part's, as JSON
   * (characters). `jsonDepthMax`: nesting of any `metadata` / `data`.
   * `bodyMax`: an A2A request body (bytes) — one file at `fileMax` in
   * base64 fits; all files together are bounded by it (413 beyond).
   * `stubTextMax`: what is kept of a message before its call has begun
   * (refused, waiting for the owner): this much text, no files, no metadata.
   */
  metadataMax: 16 * 1024,
  jsonDepthMax: 32,
  bodyMax: 16 * 1024 * 1024 + 64 * 1024,
  stubTextMax: 2000,
  /** Unfinished tasks one caller may have on one agent (beyond: 429, nothing stored). */
  openTasksPerAgent: 16,
  /** Conversations one caller may have alive (all agents; beyond: 429). */
  contextsPerCaller: 50,
  /** What one caller's messages may take, stored and waiting together (bytes; beyond: 429). */
  storedBytesPerCaller: 64 * 1024 * 1024,
  /** SendMessage requests per caller per minute (resends included; beyond: 429). */
  sendsPerMinute: 60,
  /** Connections one caller may hold open on blocking SendMessage (beyond: 503 + Retry-After). */
  heldPerCaller: 8,
  /** P4-04 review L-2: a task waiting on the caller is failed after this long idle … */
  inputIdleMs: 24 * HOUR,
  /** … and takes at most this many messages from the caller (the first included). */
  messagesPerTask: 16,
  /** trace.md §5: a call may cause a turn of depth ≤ 8 … */
  traceMaxDepth: 8,
  /** … and one trace id may be seen (sent + received here) ≤ 64 times. */
  traceMaxCalls: 64,
} as const;

/**
 * P4-04 review M-2: the outside face's listener — at most this many open
 * connections, and TCP keep-alive so a caller that vanished does not hold
 * a socket forever.
 */
export const FACE_LIMITS = {
  externalMaxConnections: 1024,
  tcpKeepAliveMs: 60_000,
} as const;

/**
 * P4-08 (ADR-127, a2a-usage.md §15): this Daisy calling another one — the
 * A2A client tools. Polling per limits.md §2 (2 s, ×1.5, at most 30 s;
 * while the other owner has not approved yet, at most 5 minutes).
 */
export const A2A_CLIENT_LIMITS = {
  /** A token signed per request (token.md §5: ≤ 5 minutes; ours are shorter). */
  tokenTtlS: 120,
  /** One request: connect + answer (card, send, get). */
  requestTimeoutMs: 10_000,
  /** The directory, per contact (discovery asks them all at once). */
  discoverTimeoutMs: 5_000,
  /** How long the call tool waits for the first answer before handing back the call id. */
  inlineWaitMs: 6_000,
  /** A directory / a card: the most bytes read. */
  cardMaxBytes: 256 * 1024,
  /** A task (with its inline files): the most bytes read. */
  taskMaxBytes: 48 * 1024 * 1024,
  /** Agents read from one directory; contacts asked at once by discovery. */
  directoryMax: 200,
  discoverContactsMax: 16,
  /** Ids the other side made (contextId, taskId) longer than this are not taken. */
  idMax: 200,
  /** The answer handed to the AI (characters). */
  answerMax: 50_000,
  /** Polling the task: first wait, factor, longest wait; longest while AUTH_REQUIRED. */
  pollFirstMs: 2_000,
  pollFactor: 1.5,
  pollMaxMs: 30_000,
  pollAuthMaxMs: 5 * 60_000,
  /** The other side's Retry-After (429 / 503) is honoured up to this. */
  retryAfterMaxMs: 10 * 60_000,
  /** Sending again (same messageId) after a network failure: tries. */
  sendAttempts: 5,
  /** Polling failing this many times in a row (offline): the call is given up. */
  pollFailuresMax: 40,
  /** A call still open after this long is given up (the other owner's card lasts 7 days). */
  callMaxMs: 8 * 24 * HOUR,
  /** A call's text (characters, = A2A_LIMITS.textMax). */
  textMax: 50_000,
  /** Calls one AI may have open at once (sent, not answered yet). */
  openPerSession: 32,
} as const;

/**
 * P5-03 (ADR-142, 7.6 「配对」): pairing codes and paired devices.
 *
 * - A pairing code: 10 Crockford base32 characters (50 random bits), good
 *   for `pairCodeTtlMs`, once. At most `pendingCodesMax` unused at a time.
 *   P5-03b review L-2: `redeemFailuresMax` wrong codes from one source
 *   (its rate-limit bucket: `external:ip:<addr>`, `relay:<addr>`) lock that
 *   source for `redeemLockMs` — never the others, so nobody who merely
 *   knows the (public) relay address keeps the owner from pairing. Over
 *   all sources a code takes at most `codeWrongMax` wrong codes in its life
 *   and is voided then — a guesser's chance per code stays about
 *   20 / 2^50, whatever its addresses. Per address: `redeemPerMinute`.
 * - A device session (the Bearer of every request, `dweb_…`): at most
 *   `sessionTtlMs` (under D-38's 24 h for owner credentials from
 *   elsewhere); at most `sessionsPerDevice` live per device (tabs).
 * - A device credential (`ddev_…`, only ever sent to trade for a session):
 *   until revoked, or `idleExpiryMs` without being used.
 */
export const DEVICE_LIMITS = {
  /** limits.md §6: 10 minutes, once (the same as a one-time code). */
  pairCodeTtlMs: 10 * 60_000,
  pendingCodesMax: 5,
  redeemFailuresMax: 5,
  redeemLockMs: 15 * 60_000,
  /** Review L-2: wrong codes (from all sources) a pairing code outlives; then it is voided. */
  codeWrongMax: 20,
  /** Sources whose wrong codes are remembered at a time (the oldest forgotten first). */
  lockSourcesMax: 1024,
  redeemPerMinute: 10,
  sessionTtlMs: 12 * 3_600_000,
  sessionsPerDevice: 4,
  sessionPerMinute: 30,
  idleExpiryMs: 30 * 86_400_000,
  /** Active devices at most (a new pairing beyond is refused). */
  activeMax: 20,
  /** Revoked / expired records kept for the list (`state=all`). */
  keepMs: 30 * 86_400_000,
  nameMax: 60,
  userAgentMax: 200,
} as const;

/**
 * P5-02 (ADR-100 「TLS 绑定声明」, ADR-144, a2a-usage.md §15.1): the claim a
 * Daisy signs with its identity key naming the TLS keys it holds, and how
 * a Daisy client reads it before it sends any token.
 */
export const TLS_BINDING_LIMITS = {
  /** A claim this Daisy signs is good this long. */
  ttlS: 24 * 3600,
  /** A claim is re-signed after this long (it is cached until then). */
  refreshS: 3600,
  /** The longest lifetime (`exp - iat`) a client accepts. */
  maxLifetimeS: 7 * 24 * 3600,
  /** Clock skew allowed on `iat`. */
  skewS: 60,
  /** The claim's text: the most bytes read. */
  maxBytes: 4096,
  /** The most TLS keys one claim names. */
  maxSpki: 8,
  /** Fetching the claim (connect + answer). */
  fetchTimeoutMs: 5_000,
} as const;

/**
 * P5-02 (ADR-144, packages/relay/PROTOCOL.md §6): this Daisy's connection
 * to a relay — reconnect backoff, the ping watchdog, streams, the
 * certificate for the relay address (ACME TLS-ALPN-01, ADR-100 B1/B2).
 */
export const RELAY_LINK_LIMITS = {
  /** Reconnect: base × 2^n, at most max, times 0.5–1 (PROTOCOL.md §6). */
  backoffBaseMs: 1_000,
  backoffMaxMs: 30_000,
  /** No ping from the relay for this many ping intervals: reconnect. */
  pingWatchdogFactor: 2.5,
  /** Before the relay said its interval (welcome.limits.pingIntervalMs). */
  pingIntervalDefaultMs: 20_000,
  /** Connecting (TCP + TLS + WebSocket upgrade) to the relay. */
  connectTimeoutMs: 10_000,
  /** Streams this Daisy takes at once through the relay (more: `reject`). */
  maxStreams: 64,
  /** The caller's ClientHello must arrive within this (to tell an ACME check from a call). */
  helloTimeoutMs: 10_000,
  helloMaxBytes: 16 * 1024,
  /** ACME: one request; the whole issuance; polling an authorization / order. */
  acmeRequestTimeoutMs: 15_000,
  acmeIssueTimeoutMs: 5 * 60_000,
  acmePollMs: 1_000,
  /** ACME failed: try again after this, doubling, at most the max. */
  acmeRetryFirstMs: 60 * 60_000,
  acmeRetryMaxMs: 24 * HOUR,
  /** Without ARI: renew when this fraction of the lifetime is left. */
  renewAtRemaining: 1 / 3,
  /** How often the renewal is looked at (ARI asked again at its Retry-After, at least this). */
  renewCheckMs: 6 * HOUR,
  /** The self-signed fallback certificate's lifetime. */
  selfSignedDays: 397,
} as const;

export const LIMITS = {
  cards: CARD_LIMITS,
  pin: PIN_LIMITS,
  token: TOKEN_LIMITS,
  events: EVENT_LIMITS,
  identityCard: IDENTITY_CARD_LIMITS,
  a2a: A2A_LIMITS,
  faces: FACE_LIMITS,
  a2aClient: A2A_CLIENT_LIMITS,
  devices: DEVICE_LIMITS,
  tlsBinding: TLS_BINDING_LIMITS,
  relayLink: RELAY_LINK_LIMITS,
} as const;
