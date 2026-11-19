/**
 * P4-01 (5.6 公钥互认, identity-card.md §4–§6, token.md §4.1, ADR-120): the
 * contacts — other Daisies' identity cards the owner added, and the one
 * place that says whether a key is someone this Daisy recognises.
 *
 * For the packages that build on it (P4-03 invocation grants, P4-04 the
 * A2A server, P4-08 the A2A client tools, P4-02 the PIN reset):
 *
 * - Lookups, all read the database every time — nothing about trust is
 *   cached, so a removal holds from the very next call:
 *   `get(id)` by identity number (spaces, any case); `byKeyRef(ref)` by
 *   identity number, base64url thumbprint (inside a URN) or URN (a
 *   token's `iss` / `sub`); `find(ref)` adds a unique prefix of ≥ 8
 *   characters (for people typing); `list()`.
 * - `verifyToken(token, { audience })`: token.md §4.1 for a token a contact
 *   signed — the contact and the verified claims, or why not.
 * - `isWhitelisted(id)` (D-15, 5.6 白名单).
 * - `onWhitelistChanged(fn)` (P4-03): told when the whitelist flag changes.
 * - `onRemoved(fn)`: told, inside the removal's transaction, of each
 *   contact removed (one by one, or all at a PIN reset) — the place to drop
 *   that person's grants and stop their calls in progress (P4-03 / P4-04).
 *   A throwing listener undoes the removal.
 * - `add` / `remove` / `removeAll` / `setWhitelist`: the routes use these;
 *   the PIN reset (T-9) calls `removeAll`.
 *
 * The contact's public key is only ever the one from its verified card.
 */
import type { KeyObject } from "node:crypto";
import type { MessageKey } from "../../../contracts/src/i18n.ts";
import { ownerT } from "../platform/language.ts";
import { TOKEN_LIMITS } from "../../../contracts/src/limits.ts";
import type { CardAddress, Contact } from "../../../contracts/src/api/contacts.ts";
import type { Store } from "../store/index.ts";
import {
  peek,
  verifyAccessToken,
  type Rejection,
  type VerifiedToken,
} from "../access/tokens/common.ts";
import { SELF_ALGORITHMS } from "../access/tokens/self-issuer.ts";
import { cardText, keyObjectOf, type IdentityCard } from "./card.ts";
import { formsOfBytes, groupedId, keyRefBytes, type PublicJwk } from "./identity.ts";

/** A contact row, as the module hands it out. */
export interface ContactRecord extends Contact {
  thumbprint: string;
  key: PublicJwk;
  /** The card's compact JWS, as imported. */
  jws: string;
}

export type ContactTokenResult =
  | { ok: true; contact: ContactRecord; token: VerifiedToken }
  | { ok: false; why: Rejection };

/** token.md §3: the `client_id` of a token one Daisy signs to call another (P4-09: defined in packages/a2a-client). */
import { A2A_CLIENT_ID } from "../../../a2a-client/src/constants.ts";
export { A2A_CLIENT_ID };

const row2contact = (r: any): ContactRecord => {
  const forms = formsOfBytes(Buffer.from(r.thumbprint, "base64url"));
  return {
    id: r.id,
    grouped: groupedId(r.id),
    urn: forms.urn,
    thumbprint: r.thumbprint,
    name: r.name,
    note: r.note ?? null,
    addrs: JSON.parse(r.addrs) as CardAddress[],
    whitelisted: r.whitelisted === 1,
    cardIssuedAt: r.card_iat,
    addedAt: r.added_at,
    updatedAt: r.updated_at,
    key: { kty: "OKP", crv: "Ed25519", x: r.x },
    jws: r.card,
  };
};

/** The API's view of a contact (no key, no JWS). */
export const publicContact = (c: ContactRecord): Contact => ({
  id: c.id,
  grouped: c.grouped,
  urn: c.urn,
  name: c.name,
  note: c.note,
  addrs: c.addrs,
  whitelisted: c.whitelisted,
  cardIssuedAt: c.cardIssuedAt,
  addedAt: c.addedAt,
  updatedAt: c.updatedAt,
});

/** The text form of a stored contact's card. */
export const contactCardText = (c: ContactRecord) =>
  cardText({
    v: 1,
    id: c.id,
    thumbprint: c.thumbprint,
    urn: c.urn,
    key: c.key,
    name: c.name,
    addrs: c.addrs,
    iat: c.cardIssuedAt,
    note: c.note,
    jws: c.jws,
  });

/** A contact not found / not unique: a message key (said in the reader's language; `message` the owner's). */
export class ContactError extends Error {
  readonly localized = true;
  constructor(
    readonly code: "contact_not_found" | "contact_ambiguous",
    readonly key: MessageKey,
    readonly params: Record<string, string | number> = {},
  ) {
    super(ownerT().dynamic(key, params));
  }
}

export class Contacts {
  private removed: ((c: ContactRecord) => void)[] = [];
  private whitelistChanged: ((c: ContactRecord) => void)[] = [];
  /** Key objects by `x` (derived, not trust: the row is read every time). */
  private keys = new Map<string, KeyObject>();

  constructor(
    private store: Store,
    /** This Daisy's own identity number (its own card cannot be added). */
    readonly selfId: string,
  ) {}

  // ── lookups ────────────────────────────────────────────────────────────
  list(): ContactRecord[] {
    return this.store.all("SELECT * FROM contacts ORDER BY added_at, id").map(row2contact);
  }
  /** By identity number, thumbprint or URN (exact). */
  byKeyRef(ref: string): ContactRecord | null {
    const b = keyRefBytes(ref);
    if (!b || b.length !== 32) return null;
    const r = this.store.one("SELECT * FROM contacts WHERE thumbprint=?", Buffer.from(b).toString("base64url"));
    return r ? row2contact(r) : null;
  }
  /** By identity number (spaces allowed, any case). */
  get(id: string): ContactRecord | null {
    return this.byKeyRef(id);
  }
  /**
   * What a person typed: an exact reference, or a unique prefix of the
   * identity number (≥ 8 characters). Throws ContactError otherwise.
   */
  find(ref: string): ContactRecord {
    const exact = this.byKeyRef(ref);
    if (exact) return exact;
    const p = String(ref).replace(/\s+/g, "").toLowerCase();
    if (p.length >= 8 && /^[a-z2-7]+$/.test(p)) {
      const hits = this.store.all("SELECT * FROM contacts WHERE substr(id,1,?)=? LIMIT 2", p.length, p);
      if (hits.length === 1) return row2contact(hits[0]);
      if (hits.length > 1)
        throw new ContactError("contact_ambiguous", "server-contacts.ambiguous", { prefix: p });
    }
    throw new ContactError("contact_not_found", "server-contacts.notFound");
  }
  isWhitelisted(id: string): boolean {
    return this.get(id)?.whitelisted === true;
  }

  // ── changes ────────────────────────────────────────────────────────────
  /**
   * Add a verified card, or replace a known contact's card with it (the
   * caller decided it may). `whitelist` undefined on a replacement keeps
   * the old setting.
   */
  put(card: IdentityCard, o: { whitelist?: boolean; via: string }): ContactRecord {
    const now = Date.now();
    return this.store.atomic(() => {
      const old = this.store.one("SELECT whitelisted FROM contacts WHERE id=?", card.id);
      const wl = o.whitelist === undefined ? (old?.whitelisted ?? 0) : o.whitelist ? 1 : 0;
      if (old)
        this.store.run(
          "UPDATE contacts SET name=?,note=?,addrs=?,card=?,card_iat=?,whitelisted=?,updated_at=? WHERE id=?",
          card.name,
          card.note,
          JSON.stringify(card.addrs),
          card.jws,
          card.iat,
          wl,
          now,
          card.id,
        );
      else
        this.store.run(
          "INSERT INTO contacts(id,thumbprint,x,name,note,addrs,card,card_iat,whitelisted,added_at,updated_at,added_via) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
          card.id,
          card.thumbprint,
          card.key.x,
          card.name,
          card.note,
          JSON.stringify(card.addrs),
          card.jws,
          card.iat,
          wl,
          now,
          now,
          o.via,
        );
      const c = this.get(card.id)!;
      if (old && (old.whitelisted === 1) !== c.whitelisted) for (const f of this.whitelistChanged) f(c);
      return c;
    });
  }
  setWhitelist(id: string, on: boolean): ContactRecord {
    const c = this.find(id);
    return this.store.atomic(() => {
      this.store.run("UPDATE contacts SET whitelisted=?,updated_at=? WHERE id=?", on ? 1 : 0, Date.now(), c.id);
      const now = this.get(c.id)!;
      if (now.whitelisted !== c.whitelisted) for (const f of this.whitelistChanged) f(now);
      return now;
    });
  }
  /** Remove one: from the next request on, its tokens are nobody's. */
  remove(id: string): ContactRecord {
    const c = this.find(id);
    this.store.atomic(() => {
      this.store.run("DELETE FROM contacts WHERE id=?", c.id);
      for (const f of this.removed) f(c);
    });
    return c;
  }
  /** Remove every contact (the PIN reset, T-9). Returns how many. */
  removeAll(): number {
    return this.store.atomic(() => {
      const all = this.list();
      this.store.run("DELETE FROM contacts");
      for (const c of all) for (const f of this.removed) f(c);
      return all.length;
    });
  }
  /**
   * P4-03: told when a contact's whitelist flag changes (`setWhitelist`, or
   * a re-import that changes it), inside the change's transaction — the
   * call authorization stops calls that stood on the whitelist alone.
   */
  onWhitelistChanged(fn: (c: ContactRecord) => void): void {
    this.whitelistChanged.push(fn);
  }
  /** Told of each contact removed, inside the removal's transaction. */
  onRemoved(fn: (c: ContactRecord) => void): void {
    this.removed.push(fn);
  }

  // ── tokens (token.md §4.1) ─────────────────────────────────────────────
  private keyOf(c: ContactRecord): KeyObject {
    let k = this.keys.get(c.key.x);
    if (!k) {
      k = keyObjectOf(c.key);
      if (this.keys.size > 1024) this.keys.clear();
      this.keys.set(c.key.x, k);
    }
    return k;
  }
  /**
   * A token a contact signed, verified against token.md §4.1: `iss` names a
   * contact (step 2 — a removed one is not found); `typ` at+jwt and `alg`
   * EdDSA (step 1); `kid` names that contact's key — its identity number,
   * base32 only (step 3; D-40 ④: the base64url thumbprint is refused); the
   * signature (step 4); `aud` this Daisy (step 5); the times, at most
   * `TOKEN_LIMITS.a2aMaxS` long (step 6). And: `sub` is the contact itself
   * (a Daisy speaks only for its own owner — recognition does not pass on,
   * 5.6 「不传递」), `client_id` is `a2a`.
   */
  /**
   * Remember `jti` of contact `contactId` until `exp` + skew: true the
   * first time, false for a replay. Old entries are dropped as it goes.
   */
  private firstUse(contactId: string, jti: string, exp: number): boolean {
    const nowS = Math.floor(Date.now() / 1000);
    return this.store.atomic(() => {
      if (nowS - this.lastPrune >= 60) {
        this.lastPrune = nowS;
        this.store.run("DELETE FROM seen_token_ids WHERE until<?", nowS);
      }
      const r = this.store.run(
        "INSERT INTO seen_token_ids(issuer,jti,until) VALUES(?,?,?) ON CONFLICT(issuer,jti) DO NOTHING",
        `contact:${contactId}`,
        jti,
        exp + TOKEN_LIMITS.clockSkewS,
      );
      return Number(r.changes) === 1;
    });
  }
  private lastPrune = 0;

  async verifyToken(token: string, o: { audience: string }): Promise<ContactTokenResult> {
    const head = peek(token);
    if (!head) return { ok: false, why: "malformed" };
    const c = this.byKeyRef(head.iss);
    if (!c || !head.iss.startsWith("urn:")) return { ok: false, why: "unknown_issuer" };
    const r = await verifyAccessToken(token, this.keyOf(c), {
      audience: o.audience,
      issuer: c.urn,
      algorithms: SELF_ALGORITHMS,
      maxLifetimeS: TOKEN_LIMITS.a2aMaxS,
    });
    if (!r.ok) return r;
    const t = r.token;
    if (t.kid !== c.id) return { ok: false, why: "unknown_key" };
    if (t.subject !== c.urn || t.clientId !== A2A_CLIENT_ID) return { ok: false, why: "bad_claims" };
    // P4-04 (P4-01 review): a cross-Daisy token is signed for exactly one
    // Daisy — `aud` is this one alone, not a list it happens to be in.
    if (t.audience.length !== 1 || t.audience[0] !== o.audience) return { ok: false, why: "wrong_audience" };
    // Removed (or replaced by another key) while the signature was checked.
    const now = this.get(c.id);
    if (!now || now.key.x !== c.key.x) return { ok: false, why: "unknown_issuer" };
    // P4-04 (P4-01 review): each token is good for one request (token.md §5:
    // "每次请求现签一张") — its `jti` is remembered per contact until it
    // could no longer pass anyway (`exp` + the clock skew), in the database
    // so a restart does not open the window again.
    if (!this.firstUse(c.id, t.jti, t.exp)) return { ok: false, why: "replayed" };
    return { ok: true, contact: now, token: t };
  }
}
