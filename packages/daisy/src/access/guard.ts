/**
 * P1-03 (5.11, 5.12, ADR-101, ADR-107 §2, ADR-110): the one place that
 * decides whether a request gets through. Every check reads the route's
 * definition (`routeDef(req)`); handlers never check who is calling.
 *
 * For every request, in order:
 *
 * 1. Host: the face's own names only (DNS rebinding).
 * 2. API routes: a foreign `Origin`, or `Sec-Fetch-Site` other than
 *    same-origin / none, is refused (W-1: another web page's request).
 * 3. No definition: a route outside the table under /api is refused (only
 *    a path that matches nothing gets its 404).
 * 4. Public (`scope: null`): health, and the web page's session exchange
 *    (which checks its own one-time code). The live socket authenticates
 *    its first frame with the same `identify` / `authorize`.
 * 5. Identify the credential (`Authorization: Bearer`): the command line's
 *    (local face only), a web session (its own face only; a code-less one
 *    no longer counts once the passcode applies), an AI's working
 *    credential (local face only; its turn still running), a token of the
 *    configured external issuer (P2-01, token.md §4.2; either face — its
 *    owner's is 「主人本人」 from elsewhere, X-1; anyone else's, or one an
 *    AI holds for the owner, is a visitor: A2A only, X-2), a token a
 *    contact signed (P4-01, token.md §4.1: its `iss` names a contact in
 *    the address book — a visitor, A2A only; a removed contact's is
 *    nobody's from the next request on). Nothing valid (bad signature,
 *    expired, another audience, unknown issuer) → 401 (X-3, T-2).
 * 6. Authorize against the definition: a visitor is refused every local
 *    route (403, A2A only — stage 4); the outside face's off switches
 *    (terminal / shell / browse), the channel (`channels`: the command
 *    line cannot answer the AI's approvals), the AI's own session
 *    (`aiSelf`), the scope, the PIN (`pin`, PinService.check; no service
 *    → refused). P4-02: a route that lets someone in (`letsIn`, or a
 *    change at a place kept for those — contracts let-in.ts) needs
 *    `daisy:grant` and the PIN even if its definition forgot them.
 *
 * P5-03 (ADR-142): a paired device's session is a web session marked
 * with its device — channel `device`, counted only while the device is
 * active (asked on every request, so revoking it is at once); a request
 * of a device revoked while it was being handled is answered 401 (onSend).
 *
 * P2-04 (ADR-115): an external interface. A server-side one (a Node
 * process) sends no `Origin` and no `Sec-Fetch-Site`, so step 2 has
 * nothing to refuse — its Bearer token is all that counts (a browser
 * always sends `Origin` on a request that carries `Authorization`, so a
 * request without one is not another web page's). A browser-side one
 * sends its own `Origin`: it passes step 2 only on the outside face and
 * only when the owner listed it (`uiOrigins`, PIN; D-38: never on the
 * local face), its preflight is answered here, its answers carry
 * CORS headers, and only the external issuer's token for the owner is
 * taken from it — never a web session or the command line's credential.
 *
 * Every refusal is answered `{ error, code }` (+ WWW-Authenticate) and
 * audited: who, which face and channel, which route, why — never the
 * credential, the PIN or the request's query (S-1). P1-11: under the
 * request's trace id (observe/request-audit.ts, installed before this);
 * an allowed request is audited when it is answered (same module).
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import {
  letsSomeoneIn,
  pinFor,
  type AnyRoute,
  type ApiScope as Scope,
} from "../../../contracts/src/index.ts";
import { routeDef } from "../app/serve.ts";
import type { Store } from "../store/index.ts";
import type { CliCredential } from "./cli-credential.ts";
import { CLI_PREFIX } from "./cli-credential.ts";
import type { WebSessions } from "./web-sessions.ts";
import { WEB_PREFIX } from "./web-sessions.ts";
import type { AiCredentials } from "./ai-credential.ts";
import { AI_SCOPES } from "./ai-credential.ts";
import { callerOf, faceOf, viaRelay, type Faces } from "./faces.ts";
import type { Face } from "./ports.ts";
import { PIN_GRANT_HEADER, type PinService } from "./pin-seam.ts";
import type { AccessConfig } from "./config.ts";
import { createHash } from "node:crypto";
import { LABEL_MAX, looksLikeJwt, peek } from "./tokens/common.ts";
import type { ExternalIssuer } from "./tokens/external-issuer.ts";
import { bindPrincipal } from "../observe/request-audit.ts";
import type { Contacts } from "../contacts/index.ts";
import { VISITOR_CLIENT_PREFIX, type VisitorTokens } from "./visitor-tokens.ts";
import { registerSecret } from "../observe/redact.ts";
import { sealLetIn } from "./let-in-commit.ts";
import { callerT, guardRefusal, rpcErrorBody, statusBody } from "../a2a/errors.ts";
import type { MessageKey } from "../../../contracts/src/i18n.ts";
import type { Devices } from "./devices.ts";

/**
 * P4-02: does this route need daisy:grant + the PIN beyond its own
 * definition (`letsIn`, or a kept place — let-in.ts)?
 */
const lettingIn = (def: AnyRoute) =>
  letsSomeoneIn({ ...def, socket: def.output.kind === "websocket" });

/** Routes outside the table that may pass (static files, review L-3). */
const OPEN_ROUTES = new Set(["/terminal-assets/:name", "/*", "/"]);

export const OWNER_SCOPES: readonly Scope[] = [
  "daisy:session:read",
  "daisy:session:write",
  "daisy:manage",
  "daisy:grant",
  // P2-03 (scopes.md, README 待决点 2 → B): the event outlet only.
  "daisy:events:read",
];

/**
 * Who a request is (token.md §3: the authentication result).
 *
 * - `owner`: the web page, a paired device, the command line.
 * - `ai`: an AI's working credential (its turn, its session).
 * - `external-owner` (P2-01): a token the configured external issuer
 *   signed for the owner's subject, without `act` — 「主人本人」 from
 *   elsewhere (X-1); its scopes are the token's ∩ the owner's.
 * - `visitor` (P2-01): any other valid token of that issuer — someone
 *   else's, or one an AI holds for the owner (`act`). A2A only (X-2):
 *   every local route refuses it. P4-01: also a token a contact signed
 *   (channel `a2a`, `contactId` set) — the same: A2A only.
 */
export interface Principal {
  kind: "owner" | "ai" | "external-owner" | "visitor";
  channel: "web" | "device" | "cli" | "ai" | "issuer" | "a2a";
  face: Face;
  /**
   * For the audit: `web`, `cli`, `ai:<session>`, `issuer`, `visitor:<sub>`,
   * `contact:<id>` / `contact-ai:<id>` — never a credential.
   */
  label: string;
  scopes: readonly Scope[];
  /** A web session's hash (logout; binding a PIN grant). */
  webSession?: string;
  /** An issuer token's SHA-256 (binding a PIN grant to that token). */
  tokenHash?: string;
  /**
   * An issuer token (review M-1): when it runs out (seconds), and which
   * issuer / owner subject it was valid under — a live socket opened with
   * it closes once any of these no longer holds.
   */
  exp?: number;
  issuer?: string;
  ownerSubject?: string;
  /** The AI's session and turn. */
  sessionId?: string;
  jobId?: string;
  /** P1-11: the AI's turn's trace id (what it does continues that trace). */
  trace?: string;
  /** P2-04: a live socket opened from an allowed external interface's origin. */
  uiOrigin?: string;
  /** P5-03: a paired device's session — which device. */
  deviceId?: string;
  /** P4-01: a visitor recognised as a contact — its identity number (contacts/). */
  contactId?: string;
  /** P4-01: a visitor's `sub` (the person: a contact's URN, or the external issuer's subject). */
  subject?: string;
  /**
   * P4-03: an external issuer's visitor — the SHA-256 (base64url) of the
   * whole `sub` (`subject` is cut to 200 characters); with `issuer`, who
   * the person is to the call authorization.
   */
  subjectHash?: string;
  /** P4-01: the AI actually acting for a visitor (`act.sub`), when the token says. */
  actor?: string;
  /**
   * P4-12 (token.md §7): the visitor came with a `daisy token` — its `jti`.
   * `selfToken`: signed `--for me` — the owner as a visitor (A2A only, the
   * call authorization as for anyone; never the owner's channels).
   */
  visitorToken?: string;
  selfToken?: true;
}

/**
 * Who a PIN grant is bound to (local-api.md §6.3): the web session that
 * traded it, or the command line. A grant taken by one is no good to the
 * other.
 */
export const holderOf = (p: Principal): string =>
  p.webSession ? `web:${p.webSession}` : p.tokenHash ? `issuer:${p.tokenHash}` : p.channel;

export interface Denial {
  status: 401 | 403 | 404;
  code: string;
  /** P6-23b: said in the caller's language when the refusal is written. */
  key: MessageKey;
  /** For a 403 (WWW-Authenticate: insufficient_scope, token.md §4.3). */
  scope?: string;
  /** Review L-1: why, for the audit only (the caller still gets `code`). */
  auditWhy?: string;
}

const deny = (
  status: Denial["status"],
  code: string,
  key: MessageKey,
  scope?: string,
): Denial => ({ status, code, key, ...(scope ? { scope } : {}) });

const NO_CREDENTIAL = deny(
  401,
  "unauthenticated",
  "server-access.guard.noCredential",
);

export interface GuardDeps {
  store: Store;
  cli: CliCredential;
  web: WebSessions;
  ai: AiCredentials;
  faces: Faces;
  pin: () => PinService | undefined;
  /** Is the passcode in force for the local face now? */
  passcodeOn: () => boolean;
  config: () => AccessConfig;
  /** P2-01: the configured external issuer, if any. */
  external: () => ExternalIssuer | null;
  /** P2-04: browser origins of external interfaces the owner allowed (normalized). */
  uiOrigins?: () => readonly string[];
  /** P4-01: the address book — tokens its contacts sign are visitors'. */
  contacts?: Contacts;
  /** P4-12: `daisy token` — tokens this Daisy signed for third-party A2A clients. */
  visitorTokens?: VisitorTokens;
  /** P5-03: paired devices (absent: a device's session is nobody's). */
  devices?: Devices;
}

/** P2-04: what a browser-side external interface may send (CORS preflight). */
const CORS_METHODS = "GET, POST, PUT, PATCH, DELETE";
const CORS_HEADERS = `authorization, content-type, if-none-match, ${PIN_GRANT_HEADER}`;
const CORS_EXPOSE = "www-authenticate, retry-after, etag";

export function accessGuard(d: GuardDeps) {
  /**
   * P5-03: the requests of each paired device being handled now — revoking
   * the device aborts their signal (`req.daisyRevoked`), so a long poll
   * stops waiting and is answered 401 at once (onSend below).
   */
  const inFlight = new Map<string, Set<{ ac: AbortController; raw: any }>>();
  d.devices?.onRevoked((ids) => {
    for (const [id, set] of inFlight)
      if (ids === null || ids.includes(id))
        for (const x of set) {
          x.ac.abort();
          // Review L-3: an answer already on its way (a download streaming)
          // is cut here — onSend ran before it started and will not again.
          if (x.raw?.headersSent && !x.raw.writableEnded) x.raw.destroy?.();
        }
  });
  // ── identify ─────────────────────────────────────────────────────────
  /** Web and command-line credentials (synchronous: no signature). */
  function identifyOwner(token: string, face: Face): Principal | null {
    if (token.startsWith(CLI_PREFIX)) {
      if (face !== "local" || !d.cli.matches(token)) return null;
      return { kind: "owner", channel: "cli", face, label: "cli", scopes: OWNER_SCOPES };
    }
    if (token.startsWith(WEB_PREFIX)) {
      const s = d.web.find(token);
      if (!s || s.face !== face) return null;
      // P5-03: a paired device's session counts while its device does —
      // asked now, every time (revoked, idle too long, another face: gone).
      if (s.device) {
        if (!d.devices || !d.devices.active(s.device, face)) {
          d.web.close(s.hash);
          return null;
        }
        return {
          kind: "owner",
          channel: "device",
          face,
          label: `device:${s.device}`,
          scopes: OWNER_SCOPES,
          webSession: s.hash,
          deviceId: s.device,
        };
      }
      // Made without a code while the passcode was off: void once it applies.
      if (!s.viaCode && (face !== "local" || d.passcodeOn())) {
        d.web.close(s.hash);
        return null;
      }
      return {
        kind: "owner",
        channel: "web",
        face,
        label: "web",
        scopes: OWNER_SCOPES,
        webSession: s.hash,
      };
    }
    return null;
  }
  /**
   * P2-01 (token.md §4.2 step 5): a token of the external issuer. Its
   * owner's, without `act`: the owner (X-1); anyone else's, or the owner's
   * with `act` (an AI acting for the owner, not bound to a turn here): a
   * visitor (X-2). Invalid in any way: nothing (X-3).
   */
  async function identifyExternal(
    token: string,
    face: Face,
    ext: ExternalIssuer,
    why?: { why?: string },
  ): Promise<Principal | null> {
    const tokenHash = createHash("sha256").update(token).digest("hex");
    // Review M-4: the owner token kept for token exchange is not a login.
    if (ext.isOwnerToken(tokenHash)) {
      if (why) why.why = "owner_token_as_bearer";
      return null;
    }
    const r = await ext.verify(token, { audience: ext.config.audience });
    if (!r.ok) {
      // Review L-1: the reason goes to the audit only (`invalid_token/<why>`:
      // a `…token:<x>` would read as a secret to P1-11's redaction).
      if (why) why.why = `invalid_token/${r.why}`;
      return null;
    }
    const t = r.token;
    if (t.subject === ext.config.ownerSubject && !t.act)
      return {
        kind: "external-owner",
        channel: "issuer",
        face,
        label: "issuer",
        // scopes.md §1 rule 2: the token's ∩ the owner's ceiling.
        scopes: OWNER_SCOPES.filter((s) => t.scopes.includes(s)),
        tokenHash,
        exp: t.exp,
        issuer: ext.issuer,
        ownerSubject: ext.config.ownerSubject,
      };
    return {
      kind: "visitor",
      channel: "issuer",
      face,
      label: t.act
        ? `issuer-ai:${t.act.sub.slice(0, 100)}`
        : `visitor:${t.subject.slice(0, 100)}`,
      // P4-04: only `daisy:invoke` is ever kept (the A2A entry is all a
      // visitor reaches, token.md §4.2 step 5) — and never for the owner's
      // own `sub` with `act` (an AI acting for the owner is not a caller of
      // the owner's agents, review L-1: like the AI's working credential).
      scopes: t.scopes.includes("daisy:invoke") && t.subject !== ext.config.ownerSubject ? ["daisy:invoke"] : [],
      tokenHash,
      // Review M-2: capped (the characters were checked with the token).
      subject: t.subject.slice(0, LABEL_MAX),
      // P4-03 review M-2 / L-1: which issuer vouched for this person, and
      // the whole `sub` (hashed) — the call authorization keys its grants
      // on both, so a cut subject or another issuer is someone else.
      issuer: ext.issuer,
      subjectHash: createHash("sha256").update(t.subject).digest("base64url"),
      ...(t.act ? { actor: t.act.sub.slice(0, LABEL_MAX) } : {}),
    };
  }
  /**
   * P4-01 (token.md §4.1, 5.6): a token one of the owner's contacts
   * signed for this Daisy — a visitor (A2A only, whatever its scope
   * says), carrying who: the contact, and the AI acting for them. Only
   * `daisy:invoke` is ever kept from its scopes (token.md §4.1 step 9).
   */
  async function identifyContact(
    token: string,
    face: Face,
    contacts: Contacts,
    why?: { why?: string },
  ): Promise<Principal | null> {
    const r = await contacts.verifyToken(token, { audience: d.ai.urn });
    if (!r.ok) {
      if (why) why.why = `invalid_token/${r.why}`;
      return null;
    }
    const t = r.token;
    return {
      kind: "visitor",
      channel: "a2a",
      face,
      label: t.act ? `contact-ai:${r.contact.id}` : `contact:${r.contact.id}`,
      scopes: t.scopes.includes("daisy:invoke") ? ["daisy:invoke"] : [],
      tokenHash: createHash("sha256").update(token).digest("hex"),
      exp: t.exp,
      contactId: r.contact.id,
      subject: r.contact.urn,
      ...(t.act ? { actor: t.act.sub.slice(0, LABEL_MAX) } : {}),
    };
  }
  /**
   * P4-12 (token.md §4.1 steps 7–9, §7): a `daisy token` — signed by this
   * Daisy for a contact (that contact, as a visitor) or for the owner
   * (`selfToken`: still only a visitor). On either face: the A2A entry is
   * all it reaches.
   */
  async function identifyVisitorToken(
    token: string,
    face: Face,
    vt: VisitorTokens,
    why?: { why?: string },
  ): Promise<Principal | null> {
    const r = await vt.verify(token);
    if (!r.ok) {
      if (why) why.why = `invalid_token/${r.why}`;
      return null;
    }
    const t = r.token;
    return {
      kind: "visitor",
      channel: "a2a",
      face,
      label: `daisy-token/${t.jti}`,
      scopes: ["daisy:invoke"],
      tokenHash: createHash("sha256").update(token).digest("hex"),
      exp: t.exp,
      subject: t.subject,
      visitorToken: t.jti,
      ...(r.contact ? { contactId: r.contact.id } : { selfToken: true as const }),
    };
  }
  /** Any credential; the AI's is checked against its running turn. */
  async function identify(
    token: string,
    face: Face,
    why?: { why?: string },
  ): Promise<Principal | null> {
    if (!token || token.length > 8192) return null;
    const owner = identifyOwner(token, face);
    if (owner || !looksLikeJwt(token)) return owner;
    // Route by `iss` (token.md §4): the external issuer, or this Daisy.
    const head = peek(token);
    const iss = head?.iss;
    const ext = d.external();
    if (ext && iss === ext.issuer) return identifyExternal(token, face, ext, why);
    // P4-12: this Daisy's own token for a third-party client (`daisy token`).
    if (iss === d.ai.urn && head?.clientId?.startsWith(VISITOR_CLIENT_PREFIX)) {
      if (!d.visitorTokens) return null;
      return identifyVisitorToken(token, face, d.visitorTokens, why);
    }
    if (iss !== d.ai.urn) {
      // P4-01: someone in the address book (token.md §4.1 step 2).
      if (d.contacts && iss) return identifyContact(token, face, d.contacts, why);
      return null;
    }
    if (face !== "local") return null;
    const c = await d.ai.verify(token);
    if (!c) return null;
    const job = d.store.one(
      "SELECT session_id,status,trace FROM jobs WHERE id=?",
      c.jobId,
    );
    if (!job || job.session_id !== c.sessionId || job.status !== "running")
      return null;
    return {
      kind: "ai",
      channel: "ai",
      face,
      label: `ai:${c.sessionId}`,
      scopes: AI_SCOPES,
      sessionId: c.sessionId,
      jobId: c.jobId,
      ...(job.trace ? { trace: job.trace } : {}),
    };
  }

  // ── authorize ────────────────────────────────────────────────────────
  function authorize(
    p: Principal,
    def: AnyRoute,
    params: Record<string, unknown> | undefined,
    headers: Record<string, unknown>,
  ): Denial | null {
    // P4-04 (5.11 「外面来的」): the A2A entry is the visitors' — and only
    // theirs: the owner's channels and the AI are not callers of their own
    // agents. A visitor still needs `daisy:invoke`.
    if (def.visitors) {
      if (p.kind !== "visitor")
        return deny(
          403,
          "visitors_only",
          "server-access.guard.visitorsOnly",
        );
      if (def.scope && !p.scopes.includes(def.scope))
        return deny(403, "insufficient_scope", "server-access.guard.noInvoke", def.scope);
      return null;
    }
    // X-2: someone else's token (or an AI's held for the owner) is good
    // for the A2A entry only — no local route, whatever its scope says.
    if (p.kind === "visitor")
      return deny(
        403,
        "a2a_only",
        "server-access.guard.a2aOnly",
        def.scope ?? undefined,
      );
    if (p.face === "external" && def.external) {
      const allow = d.config().external.allow;
      if (!allow[def.external])
        return deny(
          403,
          "external_off",
          "server-access.guard.externalOff",
        );
    }
    if (!(def.channels as readonly string[]).includes(p.channel))
      return deny(
        403,
        "channel_not_allowed",
        p.channel === "cli"
          ? "server-access.guard.channelCli"
          : p.channel === "ai"
            ? "server-access.guard.channelAi"
            : "server-access.guard.channelOther",
      );
    if (p.kind === "ai") {
      const own = def.aiSelf ? params?.[def.aiSelf] : undefined;
      if (!def.aiSelf || own !== p.sessionId)
        return deny(403, "not_own_session", "server-access.guard.notOwnSession");
    }
    if (def.scope && !p.scopes.includes(def.scope))
      return deny(403, "insufficient_scope", "server-access.guard.insufficientScope", def.scope);
    // P4-02 (5.11, let-in.ts): a route that lets someone in — declared, or
    // a change at a place kept for those — needs daisy:grant and the PIN,
    // whatever its definition says (one built by hand cannot slip by).
    const letIn = lettingIn(def);
    if (letIn && !p.scopes.includes("daisy:grant"))
      return deny(
        403,
        "insufficient_scope",
        "server-access.guard.letInScope",
        "daisy:grant",
      );
    // D-40 ①: a route may want the PIN on some channels only (`pinOn`: the
    // 「调用授权」 reads on the command line, whose credential may be the
    // owner's AI); letting someone in wants it on every channel.
    if (pinFor(def, p.channel) || letIn) {
      const pin = d.pin();
      if (!pin)
        return deny(403, "pin_unavailable", "server-access.guard.pinUnavailable");
      const g = headers[PIN_GRANT_HEADER];
      const grant = typeof g === "string" ? g : undefined;
      registerSecret(grant); // S-1: a grant never reaches a log line
      const needPin = deny(
        403,
        "pin_required",
        "server-access.guard.pinRequired",
      );
      if (!pin.check(grant, holderOf(p))) return needPin;
      // Review M-3: the command line's holder is one fixed name for every
      // command-line process (the AI's too), so its grant is good for one
      // request only — used up here, right after it passed. A PinService
      // without `consume` cannot do that: the command line is refused.
      if (p.channel === "cli") {
        if (typeof pin.consume !== "function") return needPin;
        if (!pin.consume(grant!, holderOf(p))) return needPin;
      }
    }
    return null;
  }

  // ── audit (refusals) ─────────────────────────────────────────────────
  let windowStart = 0,
    written = 0,
    suppressed = 0;
  const PER_MINUTE = 300;
  /**
   * One refusal (ADR-110 §6). P1-11: with the context columns too — who
   * (the principal, when one was recognised), the route, the object, the
   * code, under the request's trace id (observe/request-audit.ts).
   */
  function audit(
    who: string,
    face: Face,
    channel: string,
    target: string,
    why: string,
    more: { principal?: Principal | null; route?: string; object?: string; status?: number } = {},
  ) {
    const now = Date.now();
    if (now - windowStart >= 60_000) {
      if (suppressed)
        d.store.audit("system", "access.denied.suppressed", JSON.stringify({ count: suppressed }));
      windowStart = now;
      written = 0;
      suppressed = 0;
    }
    if (written >= PER_MINUTE) {
      suppressed++;
      return;
    }
    written++;
    try {
      const p = more.principal;
      d.store.audit(
        who,
        "access.denied",
        JSON.stringify({ face, channel, target: target.slice(0, 300), why }),
        {
          actor: p
            ? p.kind === "ai"
              ? "ai"
              : p.kind === "visitor"
                ? "visitor"
                : p.channel === "cli"
                  ? "cli"
                  : "owner"
            : "anonymous",
          face,
          channel: (p?.channel ?? channel) as any,
          ...(p?.sessionId ? { sessionId: p.sessionId } : {}),
          ...(p?.jobId ? { jobId: p.jobId } : {}),
          ...(p?.kind === "ai" && p.trace ? { traceId: p.trace } : {}),
          route: more.route ?? target.split(" ")[0],
          object: more.object ?? "",
          outcome: "denied",
          reason: why,
          ...(more.status ? { status: more.status } : {}),
        },
      );
    } catch {
      // The audit must never turn a refusal into a 500.
    }
  }
  /** What a request is about, for the audit: the route, or its path (no query). */
  const targetOf = (req: any, def?: AnyRoute) =>
    def ? `${def.id} ${req.method} ${req.url.split("?")[0]}` : `${req.method} ${String(req.url).split("?")[0]}`;

  function refuse(
    reply: FastifyReply,
    req: any,
    x: Denial,
    who: Principal | null,
    def?: AnyRoute,
  ) {
    const face = faceOf(req);
    req.daisyAudited = true;
    audit(who?.label ?? "anonymous", face, who?.channel ?? "none", targetOf(req, def), x.auditWhy ?? x.code, {
      principal: who,
      route: def?.id ?? targetOf(req),
      object: req.params && typeof req.params === "object" ? Object.values(req.params).map(String).join("/").slice(0, 300) : "",
      status: x.status,
    });
    if (x.status === 401)
      reply.header("WWW-Authenticate", 'Bearer error="invalid_token"');
    else if (x.status === 403 && x.scope)
      reply.header(
        "WWW-Authenticate",
        `Bearer error="insufficient_scope", scope="${x.scope}"`,
      );
    // A refused WebSocket upgrade: nothing else will end that socket (the
    // websocket plugin's own hooks never ran).
    if (String(req.headers.upgrade || "").toLowerCase() === "websocket")
      reply.raw.once("finish", () => req.raw.socket?.destroy());
    // P4-04 (a2a-usage.md §9.1): the A2A entry answers in its transport's
    // error shape (the guard's own code rides along in the ErrorInfo).
    const t = callerT(req);
    reply.header("Content-Language", t.lang);
    if (def?.visitors) {
      const e = guardRefusal(x.status, x.code, { key: x.key });
      reply.header("content-type", def.id === "a2a.jsonrpc" ? "application/json" : "application/a2a+json");
      return reply.code(x.status).send(def.id === "a2a.jsonrpc" ? rpcErrorBody(null, e, t) : statusBody(e, t));
    }
    return reply.code(x.status).send({ error: t.dynamic(x.key), code: x.code });
  }

  const bearer = (req: any) => {
    const h = req.headers.authorization;
    return typeof h === "string" && h.startsWith("Bearer ") ? h.slice(7).trim() : "";
  };

  /**
   * An API request: by its definition, by the route it matched, or by the
   * path as sent (any spelling of /api — encoded, doubled slashes, case).
   */
  const isApi = (req: any, def?: AnyRoute) => {
    if (def) return true;
    const matched = String(req.routeOptions?.url ?? "");
    let path = String(req.url).split("?")[0]!;
    try {
      path = decodeURIComponent(path);
    } catch {}
    return /^\/api(\/|$)/i.test(matched) || /^\/+api(\/|$)/i.test(path);
  };
  /**
   * P2-04: is `origin` an external interface's the owner allowed — on this
   * face? D-38 (stage-2 gate): the list applies on the outside face only;
   * the local face (loopback) answers no other origin, so a public page in
   * the owner's browser never reaches this machine's loopback through it.
   */
  const uiOriginAllowed = (origin: string, face: Face) =>
    face === "external" && !!d.uiOrigins && d.uiOrigins().includes(origin.toLowerCase());

  /**
   * Steps 1–2: is this request from this face's own pages? P2-04: or, on
   * the outside face, from a browser origin the owner allowed for an
   * external interface — then
   * `req.daisyUiOrigin` is set, and only the issuer's token for the owner
   * will be taken (`fromUiOrigin`). No `Origin` and no `Sec-Fetch-Site`
   * (a server process, the command line): nothing to refuse here.
   */
  function crossSite(req: any, face: Face, def?: AnyRoute): Denial | null {
    if (!d.faces.hostAllowed(face, req.headers.host))
      return deny(403, "host_not_allowed", "server-access.guard.hostNotAllowed");
    if (!isApi(req, def)) return null;
    const origin = req.headers.origin;
    let ui = false;
    if (origin !== undefined && !d.faces.originAllowed(face, String(origin), req.headers.host)) {
      if (!uiOriginAllowed(String(origin), face))
        return deny(
          403,
          "cross_site",
          face === "external"
            ? "server-access.guard.crossSiteExternal"
            : "server-access.guard.crossSiteLocal",
        );
      ui = true;
      req.daisyUiOrigin = String(origin).toLowerCase();
    }
    const site = req.headers["sec-fetch-site"];
    if (site !== undefined && site !== "same-origin" && site !== "none" && !ui)
      return deny(403, "cross_site", "server-access.guard.crossSite");
    return null;
  }

  /**
   * P2-04: from an allowed external interface's origin, only the external
   * issuer's token for the owner (a web session or the command line's
   * credential there would be someone carrying ours to another site).
   */
  function fromUiOrigin(req: any, p: Principal): Denial | null {
    if (!req.daisyUiOrigin || p.channel === "issuer") return null;
    return deny(
      403,
      "cross_site",
      "server-access.guard.uiOriginToken",
    );
  }

  /**
   * P5-02 review L-3 (decided: off by default): the terminal, running
   * commands and browsing directories are never offered through the relay,
   * whatever the outside face's own switches say (those were turned on for
   * a listener the owner chose, not for anyone who can reach a relay).
   */
  function relayGate(req: any, def: AnyRoute): Denial | null {
    if (!def.external || !viaRelay(req)) return null;
    return deny(403, "external_off", "server-access.guard.relayOff");
  }

  /** P2-04: the CORS answer headers for an allowed external interface's origin. */
  function corsHeaders(reply: FastifyReply, origin: string) {
    reply.header("Access-Control-Allow-Origin", origin);
    reply.header("Vary", "Origin");
    reply.header("Access-Control-Expose-Headers", CORS_EXPOSE);
  }

  /** The hook: every request, before anything else runs. */
  function install(app: FastifyInstance) {
    app.addHook("onRequest", async (req: any, reply) => {
      const face = faceOf(req);
      const def = routeDef(req);
      const x = crossSite(req, face, def);
      if (x) return refuse(reply, req, x, null, def);
      if (req.daisyUiOrigin) {
        corsHeaders(reply, req.daisyUiOrigin);
        // The browser's preflight (a request with Authorization is never
        // "simple"): which methods and headers it may send. No cookies are
        // ever involved, so no Allow-Credentials.
        if (req.method === "OPTIONS" && req.headers["access-control-request-method"]) {
          reply.header("Access-Control-Allow-Methods", CORS_METHODS);
          reply.header("Access-Control-Allow-Headers", CORS_HEADERS);
          reply.header("Access-Control-Max-Age", "600");
          // Chrome's Private Network Access: a public page calling an
          // address on this machine / network asks first.
          if (req.headers["access-control-request-private-network"] === "true")
            reply.header("Access-Control-Allow-Private-Network", "true");
          return reply.code(204).send();
        }
      }
      if (!def) {
        // Review L-3: outside the table only what matches nothing (its
        // 404), the terminal page's assets and the web page's static files
        // pass — a route a plugin registers on its own never does.
        const pattern = String(req.routeOptions?.url ?? "");
        if (req.is404 || (!isApi(req) && OPEN_ROUTES.has(pattern) && ["GET", "HEAD"].includes(req.method)))
          return;
        return refuse(reply, req, deny(403, "route_not_defined", "server-access.guard.routeNotDefined"), null);
      }
      // Review L-1 (P5-03): a public route that hands out a credential — a
      // device trading its pairing code / credential, and (same class, P2-04's
      // route) the web page trading its one-time passcode — answers its own
      // page only, never an external interface's origin (the CORS answer
      // would give that page an owner credential). Nothing is used up.
      if (req.daisyUiOrigin && (def.auth === "pairing-code" || def.auth === "device-secret" || def.auth === "one-time-code"))
        return refuse(
          reply,
          req,
          deny(403, "cross_site", "server-access.guard.credentialPagesOnly"),
          null,
          def,
        );
      if (def.scope === null) return; // health; the session exchange checks its own code
      if (def.auth === "socket-first-frame") return; // the live socket: first frame
      const token = bearer(req);
      const why: { why?: string } = {};
      const p = token ? await identify(token, face, why) : null;
      if (!p)
        return refuse(reply, req, why.why ? { ...NO_CREDENTIAL, auditWhy: why.why } : NO_CREDENTIAL, null, def);
      bindPrincipal(req, p);
      const no = fromUiOrigin(req, p) ?? relayGate(req, def) ?? authorize(p, def, req.params, req.headers);
      if (no) return refuse(reply, req, no, p, def);
      req.daisyPrincipal = p;
      if (p.deviceId) {
        d.devices?.touch(p.deviceId, callerOf(req) ?? undefined);
        const id = p.deviceId;
        const ac = new AbortController();
        const entry = { ac, raw: reply.raw };
        const set = inFlight.get(id) ?? new Set<{ ac: AbortController; raw: any }>();
        inFlight.set(id, set.add(entry));
        req.daisyRevoked = ac.signal;
        reply.raw.once("close", () => {
          set.delete(entry);
          if (!set.size && inFlight.get(id) === set) inFlight.delete(id);
        });
      }
      // Review M-1: the PIN's epoch as the grant passed — the handler
      // persists only if it is unchanged (access/let-in-commit.ts).
      const pin = d.pin();
      if ((pinFor(def, p.channel) || lettingIn(def)) && pin) sealLetIn(req, pin);
    });
    // P5-03 (ADR-142): revoking a device is at once — a request of it that
    // got through before (a long poll, a slow read) is not answered with
    // data after: 401 like the next one. The device's own revoking request
    // (unpairing itself) keeps its answer.
    app.addHook("onSend", async (req: any, reply, payload) => {
      const p = req.daisyPrincipal as Principal | undefined;
      if (!p?.deviceId || req.daisyDeviceSelfRevoked || (d.devices && d.devices.active(p.deviceId, p.face)))
        return payload;
      audit(p.label, p.face, p.channel, targetOf(req, routeDef(req)), "device_revoked", {
        principal: p,
        route: routeDef(req)?.id ?? targetOf(req),
        status: 401,
      });
      reply.code(401);
      reply.removeHeader("etag");
      reply.header("content-type", "application/json; charset=utf-8");
      reply.header("WWW-Authenticate", 'Bearer error="invalid_token"');
      return JSON.stringify({ error: callerT(req).dynamic(NO_CREDENTIAL.key), code: NO_CREDENTIAL.code });
    });
    // Review M-2 (every change that got through is recorded too) is done
    // with every other action's row in one place since P1-11:
    // observe/request-audit.ts (`api.<id>`, {face, channel, status}).
  }

  /** The live socket's first frame (same rules as a Bearer request). */
  async function socketPrincipal(
    req: any,
    def: AnyRoute,
    token: string,
  ): Promise<Principal | null> {
    const face = faceOf(req);
    const why: { why?: string } = {};
    let p = await identify(token, face, why);
    // P2-04: an issuer token at its last second (inside the clock skew the
    // HTTP check allows) is not taken for a socket that would end at once.
    if (p?.kind === "external-owner" && (p.exp ?? 0) * 1000 <= Date.now()) {
      p = null;
      why.why = "expired";
    }
    const no = p ? (fromUiOrigin(req, p) ?? relayGate(req, def) ?? authorize(p, def, {}, {})) : NO_CREDENTIAL;
    if (no) {
      audit(p?.label ?? "anonymous", face, p?.channel ?? "none", targetOf(req, def), (!p && why.why) || no.code, {
        principal: p,
        route: def.id,
        status: no.status,
      });
      return null;
    }
    return req.daisyUiOrigin ? { ...p!, uiOrigin: req.daisyUiOrigin } : p;
  }

  return {
    install,
    identify,
    identifyOwner,
    uiOriginAllowed,
    authorize,
    socketPrincipal,
    audit,
    crossSite,
  };
}
export type AccessGuard = ReturnType<typeof accessGuard>;
