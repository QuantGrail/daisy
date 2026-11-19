/**
 * P4-09 (ADR-128 §4): the MCP's address book — other Daisies' identity
 * cards its owner imported (`contacts.json`, 0600). Only the signed card is
 * kept (its JWS); every load verifies it again with the shared code, so the
 * key a token is addressed to is only ever one a verified card carried.
 *
 * Import follows identity-card.md §4 and P4-01's import route
 * (contacts/routes.ts) step for step, with the same shared checks
 * (packages/a2a-client/src/card.ts — the people's lines read as a person
 * would, look-alike labels and colons folded, any other identity number in
 * them refused; `expectId`): this MCP's own card is refused; a known
 * identity is an update, shown and only taken with `update`; an older card
 * never replaces a newer one; the same card again changes nothing.
 * Nothing here is reachable from the MCP tools: only the owner, at the
 * command line, adds or removes contacts.
 *
 * TLS (ADR-127 §4): a certificate no CA vouches for is pinned on first use
 * per contact × origin (`tls-pins.json`) until the owner imports a newer
 * card of that contact.
 */
import { KeyedError, pt } from "../../contracts/src/i18n-process.ts";
import type { MessageKey } from "../../contracts/src/i18n.ts";
import {
  CARD_MAJOR,
  CARD_PREFIX,
  CardError,
  expectIdMatches,
  groupedId,
  readCard,
  type IdentityCard,
  type TlsSeen,
} from "../../a2a-client/src/index.ts";
import { MCP_NAME } from "../../contracts/src/names.ts";
import type { Home } from "./home.ts";

const FILE = "contacts.json";
const PINS = "tls-pins.json";

interface Stored {
  jws: string;
  addedAt: number;
  updatedAt: number;
}

export interface McpContact extends IdentityCard {
  addedAt: number;
  updatedAt: number;
}

export type ImportResult =
  | { result: "added" | "updated" | "unchanged"; contact: McpContact; changes: { field: string; from: unknown; to: unknown }[] }
  | never;

export class ImportError extends KeyedError {
  constructor(
    readonly code:
      | "card_invalid"
      | "card_version"
      | "contact_self"
      | "id_mismatch"
      | "card_older"
      | "contact_exists",
    key: MessageKey,
    params: Record<string, string | number> = {},
    readonly details: string[] = [],
  ) {
    super(key, params);
  }
}

/** Check the number with the other person (said when shown). */
export const verifyHint = () => pt("mcp.card.verifyHint");

export class AddressBook {
  constructor(
    private home: Home,
    private selfId: string,
  ) {}

  private stored(): Stored[] {
    const v = this.home.readJson<{ contacts?: Stored[] }>(FILE, { contacts: [] });
    return Array.isArray(v.contacts) ? v.contacts : [];
  }

  private save(list: Stored[]) {
    this.home.writeJson(FILE, { v: 1, contacts: list });
  }

  /** Every contact, each card verified again (a card that no longer verifies is left out). */
  async list(): Promise<McpContact[]> {
    const out: McpContact[] = [];
    for (const s of this.stored()) {
      try {
        const c = await readCard(`${CARD_PREFIX}${CARD_MAJOR}:${s.jws}`);
        out.push({ ...c, addedAt: s.addedAt, updatedAt: s.updatedAt });
      } catch {
        // A file edited by hand: not trusted, not used.
      }
    }
    return out;
  }

  /** By identity number (spaces, any case), a unique prefix of ≥ 8, or a unique name. */
  async find(ref: string): Promise<McpContact[]> {
    const all = await this.list();
    const compact = ref.replace(/\s+/g, "").toLowerCase();
    const exact = all.filter((c) => c.id === compact);
    if (exact.length) return exact;
    if (compact.length >= 8) {
      const pre = all.filter((c) => c.id.startsWith(compact));
      if (pre.length) return pre;
    }
    return all.filter((c) => c.name === ref.trim());
  }

  async get(id: string): Promise<McpContact | null> {
    return (await this.list()).find((c) => c.id === id) ?? null;
  }

  /** identity-card.md §4 (verification is the shared `readCard`); the update rules of P4-01. */
  async import(text: string, o: { expectId?: string; update?: boolean } = {}): Promise<ImportResult> {
    let card: IdentityCard;
    try {
      card = await readCard(text);
    } catch (e) {
      if (e instanceof CardError) throw new ImportError(e.code, e.key, e.params);
      throw e;
    }
    if (card.id === this.selfId)
      throw new ImportError("contact_self", "mcp.import.self", { name: MCP_NAME });
    if (o.expectId !== undefined && !expectIdMatches(o.expectId, card.id))
      throw new ImportError("id_mismatch", "mcp.import.idMismatch", { id: groupedId(card.id) });
    const list = this.stored();
    const old = (await this.list()).find((c) => c.id === card.id);
    const now = Date.now();
    const changes: { field: string; from: unknown; to: unknown }[] = [];
    if (old) {
      if (old.name !== card.name) changes.push({ field: "name", from: old.name, to: card.name });
      if ((old.note ?? null) !== card.note) changes.push({ field: "note", from: old.note, to: card.note });
      if (JSON.stringify(old.addrs) !== JSON.stringify(card.addrs)) changes.push({ field: "addrs", from: old.addrs, to: card.addrs });
      if (old.jws === card.jws) return { result: "unchanged", contact: old, changes: [] };
      // §5: an older card never replaces a newer one (a replayed old card would take a changed address back).
      if (card.iat < old.iat)
        throw new ImportError(
          "card_older",
          "mcp.import.older",
          { iat: new Date(card.iat * 1000).toISOString(), old: new Date(old.iat * 1000).toISOString() },
        );
      if (!o.update)
        throw new ImportError(
          "contact_exists",
          changes.length ? "mcp.import.existsChanged" : "mcp.import.exists",
          { name: old.name, id: groupedId(old.id), fields: changes.map((c) => c.field).join(pt("mcp.list.separator")) },
          changes.map((c) => `${c.field}: ${JSON.stringify(c.from)} → ${JSON.stringify(c.to)}`),
        );
    }
    const kept = list.filter((s) => {
      try {
        return JSON.parse(Buffer.from(s.jws.split(".")[1]!, "base64url").toString("utf8")).id !== card.id;
      } catch {
        return true;
      }
    });
    kept.push({ jws: card.jws, addedAt: old?.addedAt ?? now, updatedAt: now });
    this.save(kept);
    return { result: old ? "updated" : "added", contact: { ...card, addedAt: old?.addedAt ?? now, updatedAt: now }, changes };
  }

  /** Remove a contact (and the certificates pinned for it). */
  async remove(id: string): Promise<boolean> {
    const c = await this.get(id);
    if (!c) return false;
    this.save(this.stored().filter((s) => s.jws !== c.jws));
    const pins = this.pins();
    for (const k of Object.keys(pins)) if (k.startsWith(`${id} `)) delete pins[k];
    this.home.writeJson(PINS, pins);
    return true;
  }

  private pins(): Record<string, { sha256: string; cardIat: number; firstSeen: number }> {
    return this.home.readJson(PINS, {});
  }

  /** ADR-127 §4: a self-signed certificate is pinned on first use per contact × origin, until a newer card. */
  tlsCheck(c: McpContact, seen: TlsSeen): true | string {
    const pins = this.pins();
    const key = `${c.id} ${seen.origin}`;
    const pin = pins[key];
    if (pin && pin.cardIat === c.iat) {
      if (pin.sha256 === seen.fingerprint) return true;
      return pt("mcp.tls.pinMismatch");
    }
    pins[key] = { sha256: seen.fingerprint, cardIat: c.iat, firstSeen: Date.now() };
    this.home.writeJson(PINS, pins);
    return true;
  }
}
