/**
 * P4-12 (总纲 5.6 「第三方 A2A 客户端」, 5.10 `daisy token`, token.md §7,
 * ADR-132): tokens this Daisy signs for A2A clients we did not write.
 *
 * A token: `iss` = `aud` = this Daisy's URN; `sub` = the contact's URN
 * (`me`: this Daisy's own); `scope` exactly `daisy:invoke`; `client_id`
 * `token:<jti>`; no `act`; at most 90 days. Only the record is kept
 * (`visitor_tokens`: jti, who, note, expiry, revocation, last use), never
 * the token — it is shown once, in the answer to the issuing request.
 *
 * Verifying (token.md §4.1 with step 7): the signature with this Daisy's
 * own key, the claims above exactly, then the record — present, not
 * revoked, same person, same expiry; a contact still in the address book.
 * The guard makes a visitor of it (A2A only, whatever it says): the
 * contact itself for the call authorization (D-19), or — `me` — the owner
 * as a visitor, never the owner (`selfToken`, invoke-access.ts).
 *
 * Taken back: one by one (the owner, PIN), all of a contact's when the
 * contact is removed (in the removal's transaction), all at a PIN reset
 * (the `visitor-tokens` revocation, T-9).
 */
import { englishText, msg, type Msg } from "../app/errors.ts";
import { ownerT } from "../platform/language.ts";
import type { Translate } from "../../../contracts/src/i18n.ts";
import type { Store } from "../store/index.ts";
import { TOKEN_LIMITS } from "../../../contracts/src/limits.ts";
import { ttlSeconds, type VisitorToken } from "../../../contracts/src/api/tokens.ts";
import { newJti, type SelfIssuer } from "./tokens/self-issuer.ts";
import type { Rejection, VerifiedToken } from "./tokens/common.ts";
import { ContactError, type ContactRecord, type Contacts } from "../contacts/index.ts";

export const VISITOR_CLIENT_PREFIX = "token:";
const SCOPE = "daisy:invoke";
/** Records past their end are kept this long for the list (`state=all`). */
const KEEP_MS = 30 * 24 * 3600_000;

/** What the issuing answer warns (P6-23b: in `t`'s language). */
export const visitorTokenWarning = (t: Translate = ownerT()) => t("server-access.token.warning");

export class VisitorTokenError extends Error {
  constructor(
    readonly status: number,
    readonly code: "token_not_found" | "too_many_tokens" | "bad_ttl" | ContactError["code"],
    /** P6-23b: a message key (said in the request's language), or text already said (a ContactError's). */
    readonly text: Msg | string,
  ) {
    super(typeof text === "string" ? text : englishText(text.key, text.params));
  }
}

export type VisitorVerifyResult =
  | { ok: true; token: VerifiedToken; record: VisitorToken; contact: ContactRecord | null }
  | { ok: false; why: Rejection | "revoked" | "unknown_record" | "contact_gone" };

const view = (r: any, now: number): VisitorToken => ({
  jti: r.jti,
  for: { kind: r.contact_id ? "contact" : "me", contactId: r.contact_id ?? null, name: r.name },
  note: r.note ?? null,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  revokedAt: r.revoked_at ?? null,
  revokedWhy: r.revoked_why ?? null,
  lastUsedAt: r.last_used_at ?? null,
  state: r.revoked_at ? "revoked" : r.expires_at <= now ? "expired" : "active",
});

export class VisitorTokens {
  private now: () => number;
  constructor(
    private store: Store,
    private self: SelfIssuer,
    private contacts: Contacts,
    o: { now?: () => number } = {},
  ) {
    this.now = o.now ?? Date.now;
    // A removed contact's tokens go with them, in the removal's transaction.
    contacts.onRemoved((c) => {
      this.store.run(
        "UPDATE visitor_tokens SET revoked_at=?,revoked_why='contact_removed' WHERE contact_id=? AND revoked_at IS NULL",
        this.now(),
        c.id,
      );
    });
  }

  /** Who `for` names: a contact (identity number or a unique prefix), or `me`. */
  resolve(forRef: string): { subject: string; contactId: string | null; name: string } {
    if (forRef.trim().toLowerCase() === "me") return { subject: this.self.urn, contactId: null, name: ownerT()("server-access.token.me") };
    try {
      const c = this.contacts.find(forRef);
      return { subject: c.urn, contactId: c.id, name: c.name };
    } catch (e) {
      if (e instanceof ContactError)
        throw new VisitorTokenError(e.code === "contact_ambiguous" ? 409 : 404, e.code, e.message);
      throw e;
    }
  }

  /**
   * Sign a token (async: the signature) — nothing is stored; `commit`
   * stores the record (sync, inside the route's `commitLetIn`). A token
   * whose record was never committed verifies as nobody's.
   */
  async sign(b: { for: string; ttl?: string }): Promise<{ token: string; jti: string; exp: number; who: ReturnType<VisitorTokens["resolve"]> }> {
    const who = this.resolve(b.for);
    const ttlS = b.ttl ? ttlSeconds(b.ttl) : TOKEN_LIMITS.visitorDefaultS;
    if (ttlS === null || ttlS < TOKEN_LIMITS.visitorMinS || ttlS > TOKEN_LIMITS.visitorMaxS)
      throw new VisitorTokenError(400, "bad_ttl", msg("server-access.token.badTtl"));
    this.active(true);
    const jti = newJti();
    const t = await this.self.sign({
      sub: who.subject,
      aud: this.self.urn,
      clientId: VISITOR_CLIENT_PREFIX + jti,
      scope: SCOPE,
      ttlS,
      jti,
    });
    return { token: t.token, jti, exp: t.exp, who };
  }

  /** Store the record of a token `sign` made (sync). */
  commit(s: { jti: string; exp: number; who: ReturnType<VisitorTokens["resolve"]> }, note: string | undefined, by: string): VisitorToken {
    // Still there (a removal could have happened while signing)?
    if (s.who.contactId && !this.contacts.get(s.who.contactId))
      throw new VisitorTokenError(404, "contact_not_found", msg("server-access.token.contactGone"));
    this.active(true);
    const now = this.now();
    this.store.run(
      "INSERT INTO visitor_tokens(jti,subject,contact_id,name,note,created_at,expires_at,created_by) VALUES(?,?,?,?,?,?,?,?)",
      s.jti,
      s.who.subject,
      s.who.contactId,
      s.who.name,
      note?.trim() || null,
      now,
      s.exp * 1000,
      by,
    );
    this.store.audit(by, "visitor-token.issue", JSON.stringify({ jti: s.jti, for: s.who.contactId ?? "me", expiresAt: s.exp * 1000 }), {
      object: `visitor-token:${s.jti}`,
    });
    return this.get(s.jti)!;
  }

  /** In force now (refuses a new one past the cap when `check`). */
  private active(check: boolean): number {
    const n = Number(
      this.store.one("SELECT COUNT(*) n FROM visitor_tokens WHERE revoked_at IS NULL AND expires_at>?", this.now()).n,
    );
    if (check && n >= TOKEN_LIMITS.visitorActiveMax)
      throw new VisitorTokenError(
        409,
        "too_many_tokens",
        msg("server-access.token.tooMany", { n, max: TOKEN_LIMITS.visitorActiveMax }),
      );
    return n;
  }

  get(jti: string): VisitorToken | null {
    const r = this.store.one("SELECT * FROM visitor_tokens WHERE jti=?", jti);
    return r ? view(r, this.now()) : null;
  }

  list(state: "active" | "all" = "active"): VisitorToken[] {
    const now = this.now();
    // Records long past their end are forgotten.
    this.store.run(
      "DELETE FROM visitor_tokens WHERE (revoked_at IS NOT NULL AND revoked_at<?) OR expires_at<?",
      now - KEEP_MS,
      now - KEEP_MS,
    );
    const rows =
      state === "all"
        ? this.store.all("SELECT * FROM visitor_tokens ORDER BY created_at DESC")
        : this.store.all("SELECT * FROM visitor_tokens WHERE revoked_at IS NULL AND expires_at>? ORDER BY created_at DESC", now);
    return rows.map((r) => view(r, now));
  }

  revoke(jti: string, by: string): VisitorToken {
    const cur = this.get(jti);
    if (!cur) throw new VisitorTokenError(404, "token_not_found", msg("server-access.token.notFound", { jti: jti.slice(0, 64) }));
    if (cur.revokedAt) return cur;
    this.store.run("UPDATE visitor_tokens SET revoked_at=?,revoked_why='owner' WHERE jti=?", this.now(), jti);
    this.store.audit(by, "visitor-token.revoke", JSON.stringify({ jti }), { object: `visitor-token:${jti}` });
    return this.get(jti)!;
  }

  /** T-9: a PIN reset takes every token back (in its transaction). */
  revokeAll(): number {
    // Review L-1: every one not yet revoked — also those just past their
    // end (the signature check allows 60 s of clock skew).
    return Number(
      this.store.run("UPDATE visitor_tokens SET revoked_at=?,revoked_why='pin_reset' WHERE revoked_at IS NULL", this.now()).changes,
    );
  }

  /** token.md §4.1 (steps 1–7) for a token of ours whose `client_id` is `token:…`. */
  async verify(token: string): Promise<VisitorVerifyResult> {
    const r = await this.self.verify(token, { audience: this.self.urn, maxLifetimeS: TOKEN_LIMITS.visitorMaxS });
    if (!r.ok) return r;
    const t = r.token;
    // Exactly what `sign` writes: one audience, one scope, no actor.
    if (
      t.act ||
      t.audience.length !== 1 ||
      t.scopes.length !== 1 ||
      t.scopes[0] !== SCOPE ||
      t.clientId !== VISITOR_CLIENT_PREFIX + t.jti
    )
      return { ok: false, why: "bad_claims" };
    const row = this.store.one("SELECT * FROM visitor_tokens WHERE jti=?", t.jti);
    if (!row || row.subject !== t.subject || row.expires_at !== t.exp * 1000) return { ok: false, why: "unknown_record" };
    if (row.revoked_at) return { ok: false, why: "revoked" };
    // Review L-1: the record's end on this machine's clock, no skew (the
    // signature check above allows 60 s).
    if (row.expires_at <= this.now()) return { ok: false, why: "expired" };
    let contact: ContactRecord | null = null;
    if (row.contact_id) {
      contact = this.contacts.get(row.contact_id);
      if (!contact || contact.urn !== t.subject) return { ok: false, why: "contact_gone" };
    } else if (t.subject !== this.self.urn) return { ok: false, why: "unknown_record" };
    const now = this.now();
    if (!row.last_used_at || now - row.last_used_at >= TOKEN_LIMITS.visitorTouchMs)
      this.store.run("UPDATE visitor_tokens SET last_used_at=? WHERE jti=?", now, t.jti);
    return { ok: true, token: t, record: view({ ...row, last_used_at: now }, now), contact };
  }
}
