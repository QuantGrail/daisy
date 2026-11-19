/**
 * P4-01 (ADR-120): the routes of packages/contracts/src/api/contacts.ts.
 * Who may call each is the guard's to decide, from the definitions: every
 * route is `daisy:grant` on the owner's channels (never the AI, never a
 * visitor); the changes are `letsIn: "contact"` and take the PIN too. The
 * reads (export, inspect, list, show) take the PIN on the command line only (D-40 ①).
 *
 * P4-02 review M-1 (ADR-121 §4a): every change finishes its awaits (the
 * card's signature) first and then answers and writes synchronously inside
 * `commitLetIn` — so an import that was let through under a PIN reset
 * meanwhile writes nothing (409 `pin_changed`). The reads write nothing
 * and answer directly.
 */
import type { FastifyInstance } from "fastify";
import { api } from "../../../contracts/src/api/index.ts";
import type {
  CardAddress,
  CardInspection,
  ContactImportResult,
  IdentityCardView,
} from "../../../contracts/src/api/contacts.ts";
import { IDENTITY_CARD_LIMITS } from "../../../contracts/src/limits.ts";
import { serve } from "../app/serve.ts";
import { HttpError, LocalizedError } from "../app/errors.ts";
import { requestT } from "../app/language.ts";
import type { Translate } from "../../../contracts/src/i18n.ts";
import type { Store } from "../store/index.ts";
import type { Access } from "../access/index.ts";
import { faceOf } from "../access/faces.ts";
import type { Principal } from "../access/guard.ts";
import { ownerUser } from "../access/owner.ts";
import { commitLetIn } from "../access/let-in-commit.ts";
import {
  CardError,
  cardText,
  makeCard,
  cardReader,
  expectIdMatches,
  type IdentityCard,
} from "./card.ts";
import {
  ContactError,
  contactCardText,
  publicContact,
  type Contacts,
} from "./index.ts";
import { groupedId } from "./identity.ts";

/** What to check with the other person (in the reader's language). */
const verifyText = (t: Translate) => t("server-contacts.verify", { chars: IDENTITY_CARD_LIMITS.verifyChars });

export const cardView = (c: IdentityCard, t: Translate): IdentityCardView => ({
  id: c.id,
  grouped: groupedId(c.id),
  urn: c.urn,
  name: c.name,
  note: c.note,
  addrs: c.addrs,
  iat: c.iat,
  text: cardText(c),
  verify: verifyText(t),
});

const asList = (v: unknown) => (typeof v === "string" ? [v] : v);

export function registerContactRoutes(
  app: FastifyInstance,
  store: Store,
  a: Access,
): void {
  const C = api.contacts;
  const contacts: Contacts = a.contacts;
  const actor = (req: any) =>
    (req.daisyPrincipal as Principal | undefined)?.label ?? "anonymous";
  const where = (req: any, extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      face: req.daisyPrincipal?.face ?? faceOf(req),
      channel: req.daisyPrincipal?.channel ?? "none",
      ...extra,
    });
  const httpOf = (e: unknown) =>
    e instanceof CardError
      ? new LocalizedError(400, e.code, e.key, e.params)
      : e instanceof ContactError
        ? new LocalizedError(e.code === "contact_ambiguous" ? 409 : 404, e.code, e.key, e.params)
        : e;
  /** The card's text: `card`, or `cardFile` (base64 of the file). */
  const textOf = (b: { card?: string; cardFile?: string }) => {
    if (b.card !== undefined && b.cardFile !== undefined)
      throw new LocalizedError(400, "invalid_input", "server-contacts.cardAndFile");
    if (b.card !== undefined) return b.card;
    if (b.cardFile !== undefined)
      return Buffer.from(b.cardFile, "base64").toString("utf8");
    throw new LocalizedError(400, "invalid_input", "server-contacts.cardMissing");
  };
  const read = async (text: string) => {
    try {
      return await cardReader.read(text);
    } catch (e) {
      throw httpOf(e);
    }
  };
  const found = <T>(fn: () => T): T => {
    try {
      return fn();
    } catch (e) {
      throw httpOf(e);
    }
  };

  serve(app, C.contactExport, async (req) => {
    const raw = (req.query ?? {}) as Record<string, unknown>;
    const q = C.contactExport.query.parse({
      ...raw,
      direct: asList(raw.direct),
      relay: asList(raw.relay),
    });
    let addrs: CardAddress[];
    if (q.direct || q.relay)
      addrs = [
        ...(q.direct ?? []).map((url) => ({ kind: "direct" as const, url })),
        ...(q.relay ?? []).map((url) => ({ kind: "relay" as const, url })),
      ];
    else {
      // The outside face, when it is listening (D-31), and the relay address
      // while a relay is on (P5-02): the addresses others reach. Off → gone.
      const url = a.faces.external.url;
      const relayUrl = a.relayAddress();
      addrs = [
        ...(url ? [{ kind: "direct" as const, url }] : []),
        ...(relayUrl ? [{ kind: "relay" as const, url: relayUrl }] : []),
      ];
    }
    let card: IdentityCard;
    try {
      card = await makeCard(a.ai.self, {
        name:
          q.name ?? ownerUser().username.slice(0, IDENTITY_CARD_LIMITS.nameMax),
        addrs,
        note: q.note ?? null,
      });
    } catch (e) {
      throw httpOf(e);
    }
    return cardView(card, requestT(req));
  });

  serve(app, C.contactInspect, async (req): Promise<CardInspection> => {
    const b = C.contactInspect.body.parse(req.body ?? {});
    const card = await read(textOf(b));
    return { card: cardView(card, requestT(req)), self: card.id === contacts.selfId };
  });

  serve(app, C.contactImport, async (req): Promise<ContactImportResult> => {
    const b = C.contactImport.body.parse(req.body ?? {});
    const card = await read(textOf(b));
    // Every await is done: from here on, synchronously, under the PIN epoch.
    return commitLetIn(req, (): ContactImportResult => {
      // §4 step 6: not this Daisy's own card.
      if (card.id === contacts.selfId)
        throw new LocalizedError(400, "contact_self", "server-contacts.self");
      // The number the owner checked with the other person.
      if (b.expectId !== undefined) {
        const ok = expectIdMatches(b.expectId, card.id);
        if (!ok)
          throw new LocalizedError(400, "id_mismatch", "server-contacts.idMismatch", { id: groupedId(card.id) });
      }
      const old = contacts.get(card.id);
      const changes: ContactImportResult["changes"] = [];
      if (old) {
        if (old.name !== card.name)
          changes.push({ field: "name", from: old.name, to: card.name });
        if ((old.note ?? null) !== card.note)
          changes.push({ field: "note", from: old.note, to: card.note });
        if (JSON.stringify(old.addrs) !== JSON.stringify(card.addrs))
          changes.push({ field: "addrs", from: old.addrs, to: card.addrs });
        if (old.jws === card.jws) {
          // The same card again: only the whitelist may change.
          const c =
            b.whitelist !== undefined && b.whitelist !== old.whitelisted
              ? contacts.setWhitelist(old.id, b.whitelist)
              : old;
          if (c !== old)
            store.audit(
              actor(req),
              "contact.whitelist",
              where(req, { id: c.id, whitelisted: c.whitelisted }),
            );
          return {
            result: "unchanged",
            contact: publicContact(c),
            changes: [],
            verify: verifyText(requestT(req)),
          };
        }
        // §5: an older card never replaces a newer one (a replayed old card
        // would take a changed address back).
        if (card.iat < old.cardIssuedAt)
          throw new LocalizedError(409, "card_older", "server-contacts.cardOlder", {
            made: new Date(card.iat * 1000).toISOString(),
            kept: new Date(old.cardIssuedAt * 1000).toISOString(),
          });
        if (!b.update) {
          const t = requestT(req);
          const e = new HttpError(
            409,
            changes.length
              ? t("server-contacts.existsChanged", {
                  name: old.name,
                  id: groupedId(old.id),
                  fields: changes.map((c) => c.field).join(t("server.list.separator")),
                })
              : t("server-contacts.exists", { name: old.name, id: groupedId(old.id) }),
            "contact_exists",
          );
          (e as any).details = changes.map(
            (c) =>
              `${c.field}: ${JSON.stringify(c.from)} → ${JSON.stringify(c.to)}`,
          );
          throw e;
        }
      }
      const via = (req as any).daisyPrincipal?.channel ?? "none";
      const c = contacts.put(card, {
        ...(b.whitelist !== undefined ? { whitelist: b.whitelist } : {}),
        via,
      });
      store.audit(
        actor(req),
        old ? "contact.update" : "contact.add",
        where(req, {
          id: c.id,
          name: c.name,
          whitelisted: c.whitelisted,
          ...(old ? { changed: changes.map((x) => x.field) } : {}),
        }),
      );
      return {
        result: old ? "updated" : "added",
        contact: publicContact(c),
        changes,
        verify: verifyText(requestT(req)),
      };
    });
  });

  serve(app, C.contactList, async () => ({ contacts: contacts.list().map(publicContact) }));

  serve(app, C.contactShow, async (req) => {
    const c = found(() => contacts.find((req.params as any).id));
    return { contact: publicContact(c), text: contactCardText(c) };
  });

  serve(app, C.contactRemove, async (req) => {
    return commitLetIn(req, () => {
      const c = found(() => contacts.remove((req.params as any).id));
      store.audit(
        actor(req),
        "contact.remove",
        where(req, { id: c.id, name: c.name }),
      );
      return { removed: publicContact(c) };
    });
  });

  const whitelist = (on: boolean) => async (req: any) => {
    return commitLetIn(req, () => {
      const c = found(() => contacts.setWhitelist(req.params.id, on));
      store.audit(
        actor(req),
        "contact.whitelist",
        where(req, { id: c.id, whitelisted: on }),
      );
      return { contact: publicContact(c) };
    });
  };
  serve(app, C.contactWhitelistAdd, whitelist(true));
  serve(app, C.contactWhitelistRemove, whitelist(false));
}
