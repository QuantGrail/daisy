/**
 * P4-01 (5.6 公钥互认, 5.10 `daisy contact`, 5.11, D-15, ADR-120,
 * docs/contracts/identity-card.md): this Daisy's identity card, and the
 * contacts — other people's cards, the recognition 「互认」 rests on.
 *
 * Every route here takes `daisy:grant` on the owner's channels (the AI and
 * visitors never). The changes — import, remove, the whitelist — declare
 * `letsIn: "contact"` (P4-02, let-in.ts — 5.11 「添加、移除互认的名片」) and
 * so take the PIN. D-40 ① (phase-4 gate): the reads — exporting my card,
 * listing, showing, and inspecting a card (a POST that only parses the
 * text it is given) — take the PIN on the command line only (`PIN_ON_CLI`:
 * its credential may be the owner's AI), not on the web page, a paired
 * device or the issuer's token for the owner (identity-card.md §6,
 * scopes.md §2).
 *
 * packages/daisy/src/contacts/routes.ts.
 */
import { z } from "zod";
import { cmd, fileInput, group, json, route, PIN_ON_CLI } from "./route.ts";

/** identity-card.md §1 `addrs`: where this Daisy can be reached. */
export interface CardAddress {
  kind: "direct" | "relay";
  url: string;
}

/** A contact as the API shows it. */
export interface Contact {
  /** Identity number: base32 lowercase of the key's RFC 7638 thumbprint (52 characters). */
  id: string;
  /** The same in groups of four, for people to compare. */
  grouped: string;
  /** `urn:ietf:params:oauth:jwk-thumbprint:sha-256:<base64url>` — what its tokens carry as `iss`. */
  urn: string;
  name: string;
  note: string | null;
  addrs: CardAddress[];
  /** D-15: pre-approved for every agent open to all contacts. */
  whitelisted: boolean;
  /** When the card was made (seconds, its `iat`). */
  cardIssuedAt: number;
  addedAt: number;
  updatedAt: number;
}

/** A card, read and verified (inspect / export). */
export interface IdentityCardView {
  id: string;
  grouped: string;
  urn: string;
  name: string;
  note: string | null;
  addrs: CardAddress[];
  /** Seconds. */
  iat: number;
  /** The copyable text (identity-card.md §2): people's lines, then `daisy-card:1:<JWS>`. */
  text: string;
  /** What to tell the person: check the number with them over another channel. */
  verify: string;
}

/** POST /api/contacts/inspect (identity-card.md §4 step 7: look before adding). */
export interface CardInspection {
  card: IdentityCardView;
  /** It is this Daisy's own card (it cannot be added). */
  self: boolean;
}

/** POST /api/contacts. */
export interface ContactImportResult {
  /** `added`: new; `updated`: a known contact's newer card replaced the old; `unchanged`: the same card again. */
  result: "added" | "updated" | "unchanged";
  contact: Contact;
  /** On an update: what changed (name, note, addresses), old → new. */
  changes: { field: "name" | "note" | "addrs"; from: unknown; to: unknown }[];
  verify: string;
}

const cardText = z
  .string()
  .min(1)
  .max(16 * 1024)
  .describe("api.field.contacts.cardText");
const cardFile = fileInput(z.string().max(32 * 1024))
  .optional()
  .describe("api.field.contacts.cardFile");
const contactId = z
  .object({
    id: z
      .string()
      .min(8)
      .max(200)
      .describe("api.field.contacts.id"),
  })
  .strict();

export const ContactImportSchema = z
  .object({
    card: cardText.optional(),
    cardFile,
    whitelist: z
      .boolean()
      .optional()
      .describe("api.field.contacts.whitelist"),
    update: z
      .boolean()
      .optional()
      .describe("api.field.contacts.update"),
    expectId: z
      .string()
      .max(200)
      .optional()
      .describe("api.field.contacts.expectId"),
  })
  .strict();

export const ContactInspectSchema = z
  .object({ card: cardText.optional(), cardFile })
  .strict();

export const CardExportQuery = z
  .object({
    name: z.string().min(1).max(64).optional().describe("api.field.contacts.name"),
    note: z.string().max(200).optional().describe("api.field.contacts.note"),
    direct: z
      .array(z.string().max(2048))
      .max(8)
      .optional()
      .describe("api.field.contacts.direct"),
    relay: z.array(z.string().max(2048)).max(8).optional().describe("api.field.contacts.relay"),
  })
  .strict();

const idOnly = { params: contactId };

export const contacts = group("grant", {
  contactExport: route({
    method: "GET",
    path: "/api/contacts/me",
    scope: "daisy:grant",
    ...PIN_ON_CLI,
    query: CardExportQuery,
    output: json<IdentityCardView>("IdentityCardView"),
    errors: ["card_invalid"],
    cli: cmd("contact export"),
  }),
  contactInspect: route({
    method: "POST",
    path: "/api/contacts/inspect",
    scope: "daisy:grant",
    ...PIN_ON_CLI,
    notLetIn: true,
    body: ContactInspectSchema,
    output: json<CardInspection>("CardInspection"),
    errors: ["card_invalid", "card_version"],
    cli: cmd("contact inspect", { args: ["card"] }),
  }),
  contactImport: route({
    method: "POST",
    path: "/api/contacts",
    scope: "daisy:grant",
    pin: true,
    letsIn: "contact",
    body: ContactImportSchema,
    output: json<ContactImportResult>("ContactImportResult"),
    errors: ["pin_required", "card_invalid", "card_version", "contact_self", "contact_exists", "card_older", "id_mismatch"],
    cli: cmd("contact import", { args: ["card"] }),
  }),
  contactList: route({
    method: "GET",
    path: "/api/contacts",
    scope: "daisy:grant",
    ...PIN_ON_CLI,
    output: json<{ contacts: Contact[] }>("{ contacts: Contact[] }"),
    cli: cmd("contact list"),
  }),
  contactShow: route({
    method: "GET",
    path: "/api/contacts/:id",
    scope: "daisy:grant",
    ...PIN_ON_CLI,
    ...idOnly,
    output: json<{ contact: Contact; text: string }>("{ contact: Contact, text }"),
    errors: ["contact_not_found", "contact_ambiguous"],
    cli: cmd("contact show"),
  }),
  contactRemove: route({
    method: "DELETE",
    path: "/api/contacts/:id",
    scope: "daisy:grant",
    pin: true,
    letsIn: "contact",
    ...idOnly,
    output: json<{ removed: Contact }>("{ removed: Contact }"),
    errors: ["pin_required", "contact_not_found", "contact_ambiguous"],
    cli: cmd("contact remove"),
  }),
  contactWhitelistAdd: route({
    method: "PUT",
    path: "/api/contacts/:id/whitelist",
    scope: "daisy:grant",
    pin: true,
    letsIn: "contact",
    ...idOnly,
    output: json<{ contact: Contact }>("{ contact: Contact }"),
    errors: ["pin_required", "contact_not_found", "contact_ambiguous"],
    cli: cmd("contact whitelist add"),
  }),
  contactWhitelistRemove: route({
    method: "DELETE",
    path: "/api/contacts/:id/whitelist",
    scope: "daisy:grant",
    pin: true,
    letsIn: "contact",
    ...idOnly,
    output: json<{ contact: Contact }>("{ contact: Contact }"),
    errors: ["pin_required", "contact_not_found", "contact_ambiguous"],
    cli: cmd("contact whitelist remove"),
  }),
});
