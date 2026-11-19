/**
 * P4-01 (docs/contracts/identity-card.md, ADR-120): the identity card — one
 * per Daisy, exchanged to recognise each other (5.1 「身份名片」, 5.6).
 *
 * Text form (§2): a few lines for people, then one line for machines:
 *
 *   Daisy 身份名片
 *   名字：张三
 *   编号：k7m2 q6xd …            (identity number in groups of four)
 *   地址：https://…               (one line per address; none when empty)
 *   备注：…                       (only when the card has a note)
 *   daisy-card:1:<JWS>
 *
 * The JWS (compact) has header `{"alg":"EdDSA","typ":"daisy-card+jwt"}`,
 * is signed by the card's own key (self-signed), and its payload is §1's
 * fields: v, id, key (JWK), name, addrs, iat, note?.
 *
 * Import (§4) verifies, in order: whitespace removed from the machine
 * part, the major version known; header `alg` EdDSA and `typ`; the
 * signature under the payload's `key`; the identity number recomputed from
 * that key equals `id`; every people's line present agrees with the
 * payload (a mismatch names the line). The caller then refuses this
 * Daisy's own card, and treats a known `id` as an update (contacts/index.ts).
 *
 * A card proves "whoever holds this key wrote this", never "this key is
 * Zhang San's": people check the number with each other over another
 * channel (§4, the answer's `verify` hint).
 *
 * P4-09 (ADR-128): moved from packages/daisy/src/contacts/ to the shared
 * packages/a2a-client, so the standalone A2A MCP imports a card with
 * exactly this verification (Daisy's contacts/card.ts re-exports it).
 */
import { createPublicKey } from "node:crypto";
import { compactVerify, decodeProtectedHeader } from "jose";
import { KeyedError, pt } from "../../contracts/src/i18n-process.ts";
import type { MessageKey, Translate } from "../../contracts/src/i18n.ts";
import { shippedPacks } from "../../contracts/src/i18n-node.ts";
import { IDENTITY_CARD_LIMITS as L } from "../../contracts/src/limits.ts";
import type { CardAddress } from "../../contracts/src/api/contacts.ts";
import { IDENTITY_CARD_TYP, UNSAFE_TEXT } from "./constants.ts";
import { formsOfBytes, formsOfKey, groupedId, keyRefBytes, type PublicJwk } from "./identity.ts";

export const CARD_PREFIX = "daisy-card:";
/** The format's major version (the prefix's number = the payload's `v`). */
export const CARD_MAJOR = 1;

/** A verified card: its fields, and the JWS it came in. */
export interface IdentityCard {
  v: number;
  id: string;
  thumbprint: string;
  urn: string;
  key: PublicJwk;
  name: string;
  addrs: CardAddress[];
  iat: number;
  note: string | null;
  /** The compact JWS (the machine line without its prefix). */
  jws: string;
}

/** Why a card was refused: a code for programs, a message key for people. */
export class CardError extends KeyedError {
  constructor(
    readonly code: "card_invalid" | "card_version",
    key: MessageKey,
    params: Record<string, string | number> = {},
  ) {
    super(key, params);
  }
}
/** A rule's verdict: the message key and its params (null: allowed). */
export interface CardRule {
  key: MessageKey;
  params?: Record<string, string | number>;
}
const invalid = (key: MessageKey | CardRule, params?: Record<string, string | number>) =>
  typeof key === "string" ? new CardError("card_invalid", key, params) : new CardError("card_invalid", key.key, key.params);

/**
 * Control characters (newlines included) would break the text form, or a
 * terminal; bidi and invisible ones (review M-2) would make a name read as
 * something else. common.ts `UNSAFE_TEXT`.
 */
const CONTROL = UNSAFE_TEXT;
const chars = (s: string) => [...s].length;

const TEXT_RULES = {
  name: {
    notText: "a2a.card.invalid.name.notText",
    padded: "a2a.card.invalid.name.padded",
    tooLong: "a2a.card.invalid.name.tooLong",
    control: "a2a.card.invalid.name.control",
  },
  note: {
    notText: "a2a.card.invalid.note.notText",
    padded: "a2a.card.invalid.note.padded",
    tooLong: "a2a.card.invalid.note.tooLong",
    control: "a2a.card.invalid.note.control",
  },
} as const satisfies Record<string, Record<string, MessageKey>>;

/** A display name or note as it may appear on a card; why not (a message key) when it may not. */
export function textRule(v: unknown, what: "name" | "note"): CardRule | null {
  const max = what === "name" ? L.nameMax : L.noteMax;
  const k = TEXT_RULES[what];
  if (typeof v !== "string") return { key: k.notText };
  if (v !== v.trim()) return { key: k.padded };
  if (what === "name" && chars(v) < 1) return { key: "a2a.card.invalid.name.empty" };
  if (chars(v) > max) return { key: k.tooLong, params: { max } };
  if (CONTROL.test(v)) return { key: k.control };
  return null;
}

/** An address as it may appear on a card; why not (a message key) when it may not. */
export function addrRule(a: unknown): CardRule | null {
  if (!a || typeof a !== "object") return { key: "a2a.card.invalid.addr.shape" };
  const { kind, url } = a as Record<string, unknown>;
  if (kind !== "direct" && kind !== "relay") return { key: "a2a.card.invalid.addr.kind" };
  if (typeof url !== "string" || url.length > L.urlMax || CONTROL.test(url) || /\s/.test(url))
    return { key: "a2a.card.invalid.addr.url" };
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { key: "a2a.card.invalid.addr.notUrl", params: { url: url.slice(0, 100) } };
  }
  // §1: https; a direct address (inside the owner's own network) may be http.
  if (u.protocol !== "https:" && !(u.protocol === "http:" && kind === "direct"))
    return { key: "a2a.card.invalid.addr.https" };
  if (u.username || u.password) return { key: "a2a.card.invalid.addr.userinfo" };
  if (u.search || u.hash) return { key: "a2a.card.invalid.addr.queryHash" };
  return null;
}

/**
 * The lines for people (§2), without the machine line, in `t`'s language
 * (P6-23b: the labels are the pack's `a2a.card.label.*`; a reader accepts
 * the labels of every language, `labelFields`).
 */
function peopleLines(c: { id: string; name: string; addrs: CardAddress[]; note: string | null }, t: Translate): string[] {
  return [
    t("a2a.card.title"),
    t("a2a.card.line", { label: t("a2a.card.label.name"), value: c.name }),
    t("a2a.card.line", { label: t("a2a.card.label.number"), value: groupedId(c.id) }),
    ...c.addrs.map((a) => t("a2a.card.line", { label: t("a2a.card.label.address"), value: a.url })),
    ...(c.note ? [t("a2a.card.line", { label: t("a2a.card.label.note"), value: c.note })] : []),
  ];
}

/** The whole text form of a card (the people's lines in `t`'s language: this process's by default). */
export const cardText = (c: IdentityCard, t: Translate = pt) =>
  [...peopleLines(c, t), `${CARD_PREFIX}${CARD_MAJOR}:${c.jws}`].join("\n");

/**
 * Who signs a card: an Ed25519 identity key — Daisy's `SelfIssuer`, or the
 * standalone MCP's own key. `signCard` makes the JWS with exactly the
 * header `{"alg":"EdDSA","typ":"daisy-card+jwt"}` over `payload`.
 */
export interface CardSigner {
  readonly publicJwk: { kty: string; crv: string; x: string };
  signCard(payload: Record<string, unknown>): Promise<string>;
}

/**
 * Make and sign this Daisy's own card (export, §2). The fields are checked
 * with the same rules an import applies, so what is exported imports.
 */
export async function makeCard(
  self: CardSigner,
  f: { name: string; addrs: CardAddress[]; note?: string | null },
): Promise<IdentityCard> {
  const nameWhy = textRule(f.name, "name");
  if (nameWhy) throw invalid(nameWhy);
  const note = f.note ? f.note : null;
  if (note !== null) {
    const w = textRule(note, "note");
    if (w) throw invalid(w);
  }
  if (f.addrs.length > L.addrsMax) throw invalid("a2a.card.invalid.addrsMax", { max: L.addrsMax });
  for (const a of f.addrs) {
    const w = addrRule(a);
    if (w) throw invalid(w);
  }
  const key = self.publicJwk as PublicJwk;
  const forms = formsOfKey(key);
  const iat = Math.floor(Date.now() / 1000);
  const addrs = f.addrs.map((a) => ({ kind: a.kind, url: a.url }));
  const payload: Record<string, unknown> = {
    v: CARD_MAJOR,
    id: forms.id,
    key: { kty: "OKP", crv: "Ed25519", x: key.x },
    name: f.name,
    addrs,
    iat,
    ...(note !== null ? { note } : {}),
  };
  const jws = await self.signCard(payload);
  return { v: CARD_MAJOR, ...forms, key: { kty: "OKP", crv: "Ed25519", x: key.x }, name: f.name, addrs, iat, note, jws };
}

/** An Ed25519 public JWK, strictly: no private part, a 32-byte `x`. */
function publicJwkOf(k: unknown): PublicJwk {
  if (!k || typeof k !== "object" || Array.isArray(k)) throw invalid("a2a.card.invalid.keyNotJwk");
  const j = k as Record<string, unknown>;
  if (j.kty !== "OKP" || j.crv !== "Ed25519") throw invalid("a2a.card.invalid.keyNotEd25519");
  if ("d" in j) throw invalid("a2a.card.invalid.keyPrivate");
  if (typeof j.x !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(j.x)) throw invalid("a2a.card.invalid.keyX");
  const raw = Buffer.from(j.x, "base64url");
  if (raw.length !== 32 || raw.toString("base64url") !== j.x) throw invalid("a2a.card.invalid.keyX");
  return { kty: "OKP", crv: "Ed25519", x: j.x };
}

/** A public key object for a JWK (the caller validated it). */
export const keyObjectOf = (k: PublicJwk) =>
  createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: k.x }, format: "jwk" });

/**
 * Read and verify a card from its text (§4 steps 1–5). Throws CardError
 * saying which step failed.
 */
export async function readCard(text: string): Promise<IdentityCard> {
  if (typeof text !== "string" || !text.trim()) throw invalid("a2a.card.invalid.empty");
  if (Buffer.byteLength(text, "utf8") > L.textMax) throw invalid("a2a.card.invalid.tooBig", { max: L.textMax });
  // Step 1: the machine part — from the prefix on, whitespace removed (a
  // chat program may have broken the line or put spaces in it).
  const at = text.indexOf(CARD_PREFIX);
  if (at < 0) throw invalid("a2a.card.invalid.noPrefix", { prefix: CARD_PREFIX });
  if (text.indexOf(CARD_PREFIX, at + 1) >= 0) throw invalid("a2a.card.invalid.several");
  const machine = text.slice(at).replace(/\s+/g, "");
  const m = /^daisy-card:([^:]*):(.*)$/.exec(machine);
  if (!m) throw invalid("a2a.card.invalid.machineShape", { prefix: CARD_PREFIX });
  if (!/^\d{1,6}$/.test(m[1]!)) throw invalid("a2a.card.invalid.version");
  const major = Number(m[1]);
  if (major !== CARD_MAJOR)
    throw major > CARD_MAJOR
      ? new CardError("card_version", "a2a.card.newerVersion", { major })
      : invalid("a2a.card.invalid.version");
  const jws = m[2]!;
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(jws)) throw invalid("a2a.card.invalid.truncated");
  // Step 2: the header (the token's own `alg` is never trusted: allow-list).
  let header: Record<string, unknown>;
  try {
    header = decodeProtectedHeader(jws) as Record<string, unknown>;
  } catch {
    throw invalid("a2a.card.invalid.header");
  }
  if (header.alg !== "EdDSA") throw invalid("a2a.card.invalid.alg");
  if (header.typ !== IDENTITY_CARD_TYP) throw invalid("a2a.card.invalid.typ", { typ: IDENTITY_CARD_TYP });
  if ("crit" in header || "jwk" in header || "jku" in header || "x5u" in header)
    throw invalid("a2a.card.invalid.headerMembers");
  // Step 3: the signature, under the key the payload names.
  let payload: Record<string, unknown>;
  try {
    const raw = JSON.parse(Buffer.from(jws.split(".")[1]!, "base64url").toString("utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw 0;
    payload = raw;
  } catch {
    throw invalid("a2a.card.invalid.payload");
  }
  const key = publicJwkOf(payload.key);
  try {
    await compactVerify(jws, keyObjectOf(key), { algorithms: ["EdDSA"] });
  } catch {
    throw invalid("a2a.card.invalid.signature");
  }
  // §1: the fields.
  if (payload.v !== CARD_MAJOR) throw invalid("a2a.card.invalid.payloadVersion");
  const nameWhy = textRule(payload.name, "name");
  if (nameWhy) throw invalid(nameWhy);
  let note: string | null = null;
  if (payload.note !== undefined && payload.note !== null) {
    const w = textRule(payload.note, "note");
    if (w) throw invalid(w);
    note = (payload.note as string) || null;
  }
  if (!Array.isArray(payload.addrs)) throw invalid("a2a.card.invalid.addrsArray");
  if (payload.addrs.length > L.addrsMax) throw invalid("a2a.card.invalid.addrsMax", { max: L.addrsMax });
  const addrs: CardAddress[] = [];
  for (const a of payload.addrs) {
    const w = addrRule(a);
    if (w) throw invalid(w);
    addrs.push({ kind: (a as CardAddress).kind, url: (a as CardAddress).url });
  }
  if (!Number.isInteger(payload.iat) || (payload.iat as number) <= 0) throw invalid("a2a.card.invalid.iat");
  // Review L-1: not from the future (beyond clock differences) — it would
  // make every later card of this person "older" and so refused.
  if ((payload.iat as number) > Math.floor(Date.now() / 1000) + L.iatFutureMaxS)
    throw invalid("a2a.card.invalid.iatFuture");
  // Step 4: the identity number is this key's.
  const forms = formsOfKey(key);
  if (payload.id !== forms.id) throw invalid("a2a.card.invalid.idNotKey");
  // Step 5: every people's line present agrees with the payload.
  const card: IdentityCard = {
    v: CARD_MAJOR,
    ...forms,
    key,
    name: payload.name as string,
    addrs,
    iat: payload.iat as number,
    note,
    jws,
  };
  checkPeopleLines(text.slice(0, at), card);
  return card;
}

/** Invisible / format characters dropped before reading a people's line (review M-1). */
const INVISIBLE = /[\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g;
/** A people's line as a person reads it: NFKC, invisible characters gone. */
export function normalisePeopleLine(line: string): string {
  return line.normalize("NFKC").replace(INVISIBLE, "");
}

type Field = "name" | "number" | "address" | "note";
const FIELDS: readonly Field[] = ["name", "number", "address", "note"];
/**
 * Every label a reader takes, in every language's pack, → its field
 * (P6-23b; review M-1). `a2a.card.read.<field>` lists a language's
 * spellings with `|` — the label it writes, alternative and traditional
 * ones (`名称`, `編號` …) — so a card written in any language is checked
 * line by line, and so are the labels of cards written before.
 */
function labelFields(): Map<string, Field> {
  const m = new Map<string, Field>();
  for (const pack of Object.values(shippedPacks()))
    for (const f of FIELDS)
      for (const l of [pack[`a2a.card.label.${f}`], ...(pack[`a2a.card.read.${f}`] ?? "").split("|")])
        if (l && l.trim()) m.set(normalisePeopleLine(l.trim()).toLowerCase(), f);
  return m;
}
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * §4 step 5: a people's line that disagrees with the payload refuses the
 * card. Review M-1: each line is read as a person would (normalised: NFKC
 * folds fullwidth letters and look-alike colons, invisible characters go,
 * labels of every language and their traditional forms are read, from
 * the packs), and — whatever the labels — every run of 52 or
 * more base32 characters in the people's part (whitespace removed) must be
 * this card's identity number: no line may show someone else's.
 */
function checkPeopleLines(rawHead: string, c: IdentityCard) {
  const lines = rawHead.split(/\r?\n/).map(normalisePeopleLine);
  const labels = labelFields();
  const alt = [...labels.keys()].sort((a, b) => b.length - a.length).map(escapeRe).join("|");
  const lineRe = new RegExp(`^\\s*(?:>\\s*)?(${alt})\\s*[:\\u2236\\ufe13\\ufe30\\ufe55\\uff1a]\\s*(.*?)\\s*$`, "i");
  // A label counts as a break (a Latin label must not run on into the number next to it).
  const runText = lines.map((l) => {
    const lm = lineRe.exec(l);
    return lm ? `|${lm[2]}` : l;
  });
  const runs = runText.join("").replace(/\s+/g, "").toLowerCase().match(/[a-z2-7]{52,}/g) ?? [];
  for (const r of runs)
    if (r !== c.id)
      throw invalid("a2a.card.invalid.foreignNumber", {
        shown: `${groupedId(r.slice(0, 52))}${r.length > 52 ? "…" : ""}`,
        id: groupedId(c.id),
      });
  const seen: Partial<Record<Field, string[]>> = {};
  for (const line of lines) {
    const lm = lineRe.exec(line);
    if (lm) (seen[labels.get(lm[1]!.toLowerCase())!] ??= []).push(lm[2]!);
  }
  const wrong = (field: Field, shown: string, actual: string) =>
    invalid("a2a.card.invalid.lineDiffers", {
      label: pt.dynamic(`a2a.card.label.${field}`),
      shown: shown.slice(0, 120),
      actual: actual.slice(0, 120),
    });
  const twice = (field: Field) => invalid("a2a.card.invalid.lineTwice", { label: pt.dynamic(`a2a.card.label.${field}`) });
  const list = (xs: string[]) => xs.join(pt("a2a.list.separator"));
  if (seen.name) {
    if (seen.name.length > 1) throw twice("name");
    if (seen.name[0] !== normalisePeopleLine(c.name)) throw wrong("name", seen.name[0]!, c.name);
  }
  if (seen.number) {
    if (seen.number.length > 1) throw twice("number");
    const shown = seen.number[0]!.replace(/\s+/g, "").toLowerCase();
    if (shown !== c.id) throw wrong("number", seen.number[0]!, groupedId(c.id));
  }
  if (seen.address) {
    const want = c.addrs.map((a) => a.url);
    if (seen.address.join("\n") !== want.map(normalisePeopleLine).join("\n"))
      throw wrong("address", list(seen.address), list(want) || pt("a2a.card.noAddress"));
  }
  if (seen.note) {
    if (seen.note.length > 1) throw twice("note");
    if (seen.note[0] !== normalisePeopleLine(c.note ?? "")) throw wrong("note", seen.note[0]!, c.note ?? pt("a2a.card.noNote"));
  }
}

/**
 * The number the owner checked with the other person (an import's
 * `expectId`): a whole identity number (any form `keyRefBytes` takes) must
 * be the card's; otherwise at least `verifyChars` (16) characters of the
 * identity number, as its beginning.
 */
export function expectIdMatches(expect: string, cardId: string): boolean {
  const bytes = keyRefBytes(expect);
  if (bytes) return formsOfBytes(bytes).id === cardId;
  const want = expect.replace(/\s+/g, "").toLowerCase();
  return want.length >= L.verifyChars && cardId.startsWith(want);
}
