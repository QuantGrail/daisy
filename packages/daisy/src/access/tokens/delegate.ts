/**
 * P2-02 (token.md §6, 3.7, X-4, ADR-113): a token fetched for the AI of a
 * running turn, for the MCP in its harness that needs one (to reach
 * another system — never this Daisy, whose own credential the AI already
 * has).
 *
 * - External mode (an issuer is configured): RFC 8693 token exchange at
 *   the issuer's token endpoint — the owner's token as `subject_token`, a
 *   short self-signed JWT naming the AI (`sub: agent:<session>`) as
 *   `actor_token`, the client proving itself with private_key_jwt
 *   (RFC 7523, the identity key).
 * - Standalone: this Daisy signs it (SelfIssuer): `iss` = `sub` = this
 *   Daisy, `act` = the AI, `aud` = the target, `client_id` = ai:<session>.
 *
 * Either way the token is checked before the AI gets it (token.md §6):
 * signature and issuer, `aud` the one asked for, `sub` the owner, `act.sub`
 * this AI, `scope` within what was asked, `exp - iat` ≤ 1 hour. Anything off
 * → nothing handed over, an audit row, and the AI is told it cannot have
 * one. What may be asked: never `daisy:grant` (放别人进来 is never the AI's),
 * and nothing beyond the owner's — the owner's token's scope in external
 * mode, the owner's local scopes otherwise.
 *
 * A token lives at most an hour and may serve several turns (README 待决
 * 11, option A); with less than 5 minutes left a new one is fetched. The
 * route that hands it out takes only the AI's working credential, so it
 * answers only while a turn runs. Tokens are kept in memory only; the
 * audit names their `jti`, never the token (S-1).
 */
import { englishText, type MsgParams } from "../../app/errors.ts";
import type { MessageKey } from "../../../../contracts/src/i18n.ts";
import { ownerT } from "../../platform/language.ts";

const tk = (k: string) => `server-access.aiToken.${k}` as MessageKey;
import { TOKEN_LIMITS } from "../../../../contracts/src/limits.ts";
import type { AiToken } from "../../../../contracts/src/api/ai-token.ts";
import { scopesOf, type VerifyResult } from "./common.ts";
import type { SelfIssuer } from "./self-issuer.ts";
import { IssuerError, type ExternalIssuer } from "./external-issuer.ts";

const L = TOKEN_LIMITS;
export const TOKEN_EXCHANGE = "urn:ietf:params:oauth:grant-type:token-exchange";
export const ACCESS_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token";
export const JWT_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:jwt";
export const CLIENT_ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";

/** The owner's local scopes an AI's token may carry in standalone mode (scopes.md §4, minus grant). */
const SELF_CEILING = ["daisy:session:read", "daisy:session:write", "daisy:manage"];
/** Never an AI's (5.11, 原则 1). */
const NEVER = new Set(["daisy:grant"]);

/** A refusal the AI's MCP is told about (409 / 502 with the code). */
export class AiTokenError extends Error {
  /** P6-23b: the text is a message key (the route says it in the request's language); `message` is English. */
  constructor(
    readonly key: MessageKey,
    readonly params: MsgParams,
    readonly code: "ai_token_scope" | "ai_token_audience" | "ai_token_unavailable" | "ai_token_rate_limited",
    readonly status: 400 | 403 | 429 | 502,
    /** For the audit only. */
    readonly why: string,
  ) {
    super(englishText(key, params));
  }
}

interface Held extends AiToken {
  jti: string;
  sessionId: string;
}

export interface DelegateDeps {
  self: SelfIssuer;
  external: () => ExternalIssuer | null;
  audit: (action: string, detail: Record<string, unknown>) => void;
  /** P1-11's redaction layer (observe/redact.ts): every token handed out is registered. */
  registerSecret: (value: string) => void;
}

export class DelegatedTokens {
  private held = new Map<string, Held>();
  /** Review L-3: when each session last fetched a new token (ms), for the per-minute bound. */
  private fetchedAt = new Map<string, number[]>();
  constructor(private d: DelegateDeps) {}

  /** Forget every token (the issuer changed: they are another mode's). */
  clear(): void {
    this.held.clear();
  }

  /**
   * P4-02 (T-9): a PIN reset — forget every token fetched for an AI, so
   * none is handed out again; how many there were (for the reset's audit
   * row). A token already handed out stays valid where it was sent until
   * it runs out (≤ 1 hour, ADR-121 §5).
   */
  revokeAll(): number {
    const n = this.held.size;
    this.held.clear();
    return n;
  }

  /** How many are kept now (tests). */
  get size(): number {
    return this.held.size;
  }

  /** Drop expired ones (called from the access sweep). */
  sweep(now = Math.floor(Date.now() / 1000)): void {
    for (const [k, t] of this.held) if (t.expiresAt <= now) this.held.delete(k);
    const minuteAgo = Date.now() - 60_000;
    for (const [sid, at] of this.fetchedAt) {
      const kept = at.filter((t) => t > minuteAgo);
      if (kept.length) this.fetchedAt.set(sid, kept);
      else this.fetchedAt.delete(sid);
    }
  }

  /** The token for session `sessionId`'s AI (its turn is running: the guard checked). */
  async get(sessionId: string, audience: string, scope: string): Promise<AiToken> {
    const want = scopesOf(scope).sort();
    const ext = this.d.external();
    const self = this.d.self;
    const refuse = (e: AiTokenError): never => {
      this.d.audit("ai.token.refused", { session: sessionId, audience, scope: want.join(" "), why: e.why });
      throw e;
    };
    if (!want.length)
      refuse(new AiTokenError(tk("noScope"), {}, "ai_token_scope", 400, "empty_scope"));
    // This Daisy itself: the AI has its working credential for it.
    if (audience === self.urn || (ext && audience === ext.config.audience))
      refuse(
        new AiTokenError(
          tk("selfAudience"),
          {},
          "ai_token_audience",
          400,
          "self_audience",
        ),
      );
    const forbidden = want.filter((s) => NEVER.has(s));
    if (forbidden.length)
      refuse(
        new AiTokenError(
          tk("grantScope"),
          { scopes: forbidden.join(" ") },
          "ai_token_scope",
          403,
          "grant_scope",
        ),
      );
    const mode: AiToken["mode"] = ext ? "external" : "self";
    const key = `${sessionId}\n${mode}\n${ext?.issuer ?? ""}\n${audience}\n${want.join(" ")}`;
    const now = Math.floor(Date.now() / 1000);
    const had = this.held.get(key);
    if (had && had.expiresAt - now > L.aiTokenRenewS) return this.out(had);
    // Review L-3: a new token (signed, or asked of the issuer — whether it
    // then passes or not) at most this often per session: an exchange costs
    // the issuer, and a looping MCP must not hammer it.
    const spend = () => {
      const minuteAgo = Date.now() - 60_000;
      const recent = (this.fetchedAt.get(sessionId) ?? []).filter((t) => t > minuteAgo);
      if (recent.length >= L.aiTokenFetchesPerMinute)
        refuse(
          new AiTokenError(
            tk("rateLimited"),
            { max: L.aiTokenFetchesPerMinute },
            "ai_token_rate_limited",
            429,
            "rate_limited",
          ),
        );
      recent.push(Date.now());
      this.fetchedAt.set(sessionId, recent);
    };

    let got: Held;
    if (!ext) {
      const beyond = want.filter((s) => !SELF_CEILING.includes(s));
      if (beyond.length)
        refuse(
          new AiTokenError(
            tk("beyondOwnerSelf"),
            { scopes: beyond.join(" "), ceiling: SELF_CEILING.join(" ") },
            "ai_token_scope",
            403,
            "beyond_owner",
          ),
        );
      spend();
      const s = await self.sign({
        sub: self.urn,
        aud: audience,
        clientId: `ai:${sessionId}`,
        scope: want.join(" "),
        act: { sub: `agent:${sessionId}` },
        ttlS: L.aiTokenMaxS,
      });
      const v = await self.verify(s.token, { audience, maxLifetimeS: L.aiTokenMaxS });
      got = this.checked(v, s.token, { sessionId, audience, want, owner: self.urn, mode }, refuse);
    } else {
      got = await this.exchange(ext, sessionId, audience, want, refuse, spend);
    }
    this.held.set(key, got);
    // Review L-3: at most this many kept per session — the soonest to expire go first.
    const mine = [...this.held].filter(([, t]) => t.sessionId === sessionId);
    if (mine.length > L.aiTokensPerSession)
      for (const [k] of mine.sort((a, b) => a[1].expiresAt - b[1].expiresAt).slice(0, mine.length - L.aiTokensPerSession))
        this.held.delete(k);
    this.d.registerSecret(got.token);
    this.d.audit("ai.token.issue", {
      session: sessionId,
      audience,
      scope: got.scope,
      mode,
      jti: got.jti,
      exp: got.expiresAt,
    });
    return this.out(got);
  }

  private out(h: Held): AiToken {
    return {
      token: h.token,
      tokenType: "Bearer",
      expiresAt: h.expiresAt,
      audience: h.audience,
      scope: h.scope,
      mode: h.mode,
    };
  }

  /** token.md §6 「领回来之后 Daisy 自己再验一遍」. */
  private checked(
    v: VerifyResult,
    token: string,
    c: { sessionId: string; audience: string; want: string[]; owner: string; mode: AiToken["mode"] },
    refuse: (e: AiTokenError) => never,
  ): Held {
    const bad = (why: string) =>
      refuse(
        new AiTokenError(
          tk("badToken"),
          {},
          "ai_token_unavailable",
          502,
          why,
        ),
      );
    if (!v.ok) return bad(`invalid:${v.why}`);
    const t = v.token;
    if (t.subject !== c.owner) return bad("not_owner");
    if (t.act?.sub !== `agent:${c.sessionId}`) return bad("wrong_actor");
    if (t.scopes.some((s) => !c.want.includes(s))) return bad("scope_beyond_request");
    if (t.scopes.some((s) => NEVER.has(s))) return bad("grant_scope");
    if (t.exp - t.iat > L.aiTokenMaxS) return bad("too_long");
    if (t.exp <= Math.floor(Date.now() / 1000)) return bad("expired");
    return {
      token,
      tokenType: "Bearer",
      expiresAt: t.exp,
      audience: c.audience,
      scope: t.scopes.join(" "),
      mode: c.mode,
      jti: t.jti,
      sessionId: c.sessionId,
    };
  }

  private async exchange(
    ext: ExternalIssuer,
    sessionId: string,
    audience: string,
    want: string[],
    refuse: (e: AiTokenError) => never,
    spend: () => void,
  ): Promise<Held> {
    // The reason is said in the owner's language (an IssuerError's text is).
    const unavailable = (reason: string, why: string) =>
      refuse(new AiTokenError(tk("unavailable"), { why: reason }, "ai_token_unavailable", 502, why));
    const said = (k: string) => ownerT().dynamic(tk(k));
    const subjectToken = ext.ownerToken();
    if (!subjectToken)
      return unavailable(said("noOwnerToken"), "no_owner_token");
    // The owner's token: still valid, the owner's, not an AI's — and its
    // scope is the ceiling (「范围不超过主人」).
    const owner = await ext.verify(subjectToken, { audience: ext.config.audience });
    if (!owner.ok)
      return unavailable(
        owner.why === "expired"
          ? said("ownerTokenExpired")
          : said("ownerTokenInvalid"),
        `owner_token:${owner.why}`,
      );
    if (owner.token.subject !== ext.config.ownerSubject || owner.token.act)
      return unavailable(said("notOwner"), "owner_token:not_owner");
    const beyond = want.filter((s) => !owner.token.scopes.includes(s));
    if (beyond.length)
      refuse(
        new AiTokenError(tk("beyondOwner"), { scopes: beyond.join(" ") }, "ai_token_scope", 403, "beyond_owner"),
      );
    spend();
    const self = this.d.self;
    const c = ext.config;
    let answer: Record<string, unknown>;
    try {
      const actorToken = await self.signJwt({ sub: `agent:${sessionId}`, aud: c.issuer }, L.assertionS);
      const assertion = await self.signJwt({ iss: c.clientId, sub: c.clientId, aud: c.issuer }, L.assertionS);
      answer = await ext.exchange({
        grant_type: TOKEN_EXCHANGE,
        subject_token: subjectToken,
        subject_token_type: ACCESS_TOKEN_TYPE,
        actor_token: actorToken,
        actor_token_type: JWT_TOKEN_TYPE,
        requested_token_type: ACCESS_TOKEN_TYPE,
        scope: want.join(" "),
        audience,
        client_id: c.clientId,
        client_assertion_type: CLIENT_ASSERTION_TYPE,
        client_assertion: assertion,
      });
    } catch (e) {
      if (e instanceof AiTokenError) throw e;
      return unavailable(
        e instanceof IssuerError ? e.message : said("exchangeFailed"),
        e instanceof IssuerError ? e.code : "exchange_error",
      );
    }
    const token = answer.access_token;
    if (typeof token !== "string" || !token) return unavailable(said("noAccessToken"), "no_access_token");
    if (answer.issued_token_type !== ACCESS_TOKEN_TYPE) return unavailable(said("notAccessToken"), "wrong_token_type");
    if (typeof answer.token_type !== "string" || answer.token_type.toLowerCase() !== "bearer")
      return unavailable(said("notBearer"), "wrong_token_type");
    const v = await ext.verify(token, { audience, maxLifetimeS: L.aiTokenMaxS });
    return this.checked(v, token, { sessionId, audience, want, owner: c.ownerSubject, mode: "external" }, refuse);
  }
}
