/**
 * P4-02 (5.11 「放别人进来」, D-11, 原则 1 / 6, scopes.md §2, ADR-121): which
 * routes let someone else in, and what a PIN reset takes back.
 *
 * A route that lets others in names its kind (`letsIn`). The definition
 * table then forces it to `daisy:grant` + the PIN (route.ts `group`), the
 * server refuses to register one that says otherwise (app/serve.ts), and
 * the guard asks for both whatever the definition says (access/guard.ts).
 *
 * Kinds whose routes do not exist yet (phase 4 / 5 packages add them) are
 * already here, and so are the places their routes will live: a change
 * (not a GET; a socket too) whose path carries one of `LET_IN_WORDS`, and
 * any change in the 「调用授权」 or settings group, that does not declare
 * its kind is refused when it is defined — or, if someone builds a
 * definition by hand, still asked for `daisy:grant` and the PIN by the
 * guard. A change there that really lets nobody in says so in `notLetIn`
 * (a reason, shown in the docs; the test pins the list).
 *
 * Reading is not letting in (D-40 ①, the phase-4 gate): a GET never
 * declares a kind. The 「调用授权」 group's reads keep `daisy:grant` (the
 * AI's credential and visitors read nothing) and take the PIN on the
 * command line only (`PIN_ON_CLI`: its credential may be the owner's AI
 * through Bash) — not on the web page, a paired device or the issuer's
 * token for the owner. A read-only change at a kept place (inspecting a
 * card) says so in `notLetIn`.
 *
 * Revocation: each kind names what a PIN reset must take back (5.11 「重置
 * PIN … 会吊销全部对外授权、互认的名片和配对的设备」, T-9). The server's
 * revocation registry (access/revocations.ts) runs one hook per kind;
 * a kind whose store does not exist yet is recorded as `pending`.
 */

/**
 * What a PIN reset takes back (T-9), and who builds the store. What it
 * is, in words: the packs' `api.revocation.<kind>` (P6-23a).
 */
export const REVOCATIONS = {
  issuer: {
    by: "P2-01",
  },
  "ui-origins": {
    by: "P2-04",
  },
  "external-face": {
    by: "P1-03",
  },
  "ai-tokens": {
    by: "P2-02 / P4-08",
  },
  "invoke-grants": {
    by: "P4-03",
  },
  contacts: {
    by: "P4-01",
  },
  devices: {
    by: "P5-03",
  },
  "visitor-tokens": {
    by: "P4-12",
  },
} as const;
export type RevocationKind = keyof typeof REVOCATIONS;
export const REVOCATION_KINDS = Object.keys(REVOCATIONS) as RevocationKind[];

/**
 * 5.11's 「放别人进来」 rows (and the three that let the owner's own page
 * in from elsewhere, D-31 / D-09 / D-38). `revokes`: what a PIN reset
 * takes back for this kind (null: nothing is left standing once the
 * rest is gone — e.g. a public agent nobody may call any more). The
 * row in words: the packs' `api.letIn.<kind>` (P6-23a).
 */
export const LET_IN = {
  "invoke-request": {
    by: "P4-03",
    revokes: "invoke-grants",
  },
  "agent-exposure": {
    by: "P4-05 / P4-06 / P4-07",
    revokes: null,
  },
  "agent-audience": {
    by: "P4-03 / P4-06",
    revokes: "invoke-grants",
  },
  "invoke-grant": {
    by: "P4-03",
    revokes: "invoke-grants",
  },
  contact: {
    by: "P4-01",
    revokes: "contacts",
  },
  device: {
    by: "P5-03",
    revokes: "devices",
  },
  issuer: {
    by: "P2-01",
    revokes: "issuer",
  },
  relay: {
    by: "P5-02",
    revokes: null,
  },
  "visitor-token": {
    by: "P4-12",
    revokes: "visitor-tokens",
  },
  face: {
    by: "P1-03",
    revokes: "external-face",
  },
  "ui-origin": {
    by: "P2-04",
    revokes: "ui-origins",
  },
} as const satisfies Record<
  string,
  { by: string; revokes: RevocationKind | null }
>;
export type LetInKind = keyof typeof LET_IN;
export const LET_IN_KINDS = Object.keys(LET_IN) as LetInKind[];

/**
 * Where the routes of the kinds still to come will live (scopes.md §2,
 * 5.10). Review M-2: not a fixed list of prefixes — a path is split into
 * segments (case folded, `:param(regex)` constraints dropped, parameters
 * skipped) and each segment into words (at `-`, `_`, `.`); a word that
 * starts with one of these marks the place as kept for those kinds,
 * wherever in the path it is (`/api/settings/contacts`, `/api/a2a/tokens`,
 * `/api/pairing-codes`, `/api/invoke-approvals/:aid/respond`, …).
 */
export const LET_IN_WORDS: readonly { word: RegExp; kinds: readonly LetInKind[] }[] = [
  { word: /^(contact|card)/, kinds: ["contact"] },
  { word: /^(device|pair)/, kinds: ["device"] },
  { word: /^relay/, kinds: ["relay"] },
  { word: /^token/, kinds: ["visitor-token"] },
  { word: /^(grant|allowlist|whitelist)/, kinds: ["invoke-grant"] },
  { word: /^(invoke|invocation|request)/, kinds: ["invoke-request", "invoke-grant"] },
  { word: /^(agent|resident)/, kinds: ["agent-exposure", "agent-audience"] },
  { word: /^(public|visib|expos|audience|shar(e|ing))/, kinds: ["agent-exposure", "agent-audience"] },
];
/** Under a session (`…/sessions/:id/…`), who may reach it: `access`. */
const SESSION_WORDS = /^(access)/;

/**
 * The groups where every change must say what it is (`letsIn` or
 * `notLetIn`): the 「调用授权」 group, and settings (relay, pairing,
 * tokens, the issuer, the faces all live there) — review M-2.
 */
export const LET_IN_GROUPS: readonly string[] = ["grant", "settings"];

/** The words of a path's fixed segments (lower case; parameters skipped). */
export function pathWords(path: string): { words: string[]; underSession: boolean } {
  const segs = path
    .toLowerCase()
    // `:id(^[a-z0-9-]+$)` → `:id` (a regex constraint holds no place name).
    .replace(/:([a-z_][\w]*)\([^/]*\)/g, ":$1")
    .split("/")
    .filter(Boolean);
  const words: string[] = [];
  let underSession = false;
  for (const seg of segs) {
    if (seg.startsWith(":") || seg === "*") continue;
    if (/^sessions?$/.test(seg)) underSession = true;
    words.push(...seg.split(/[-_.]+/).filter(Boolean));
  }
  return { words, underSession };
}

/** The part of a definition these rules read. */
export interface LetInShape {
  id?: string;
  method: string;
  path: string;
  group?: string;
  scope: string | null;
  pin?: boolean;
  /** D-40 ①: the PIN only on these channels (route.ts `pinOn`). */
  pinOn?: readonly string[];
  aiSelf?: string;
  letsIn?: LetInKind;
  notLetIn?: true;
  /**
   * A WebSocket route (review L-3): always a GET, but a socket at a kept
   * place must still say what it is — and one that lets someone in needs
   * a PIN grant its first frame cannot carry, so it is refused (fails
   * closed) until a socket PIN exists.
   */
  socket?: boolean;
}

/** The kinds a place is kept for, whatever the method (empty: none). */
export function letInKindsOfPath(path: string): readonly LetInKind[] {
  const { words, underSession } = pathWords(path);
  const out = new Set<LetInKind>();
  for (const w of words) {
    for (const r of LET_IN_WORDS) if (r.word.test(w)) for (const k of r.kinds) out.add(k);
    if (underSession && SESSION_WORDS.test(w)) {
      out.add("agent-exposure");
      out.add("agent-audience");
    }
  }
  return [...out];
}

/**
 * The kinds a route's place implies (empty: none): a change — or a
 * socket — at a kept path, or any change in a group of `LET_IN_GROUPS`
 * (where every kind may live).
 */
export function letInKindsAt(
  r: Pick<LetInShape, "method" | "path" | "group" | "socket">,
): readonly LetInKind[] {
  if (r.method === "GET" && !r.socket) return [];
  const at = letInKindsOfPath(r.path);
  if (at.length) return at;
  return r.group !== undefined && LET_IN_GROUPS.includes(r.group) && !r.socket ? LET_IN_KINDS : [];
}

/**
 * Does this route let someone in? Declared (`letsIn`), or — undeclared —
 * a change at a place reserved for those routes, unless it says why not
 * (`notLetIn`). The guard asks such a route for `daisy:grant` and the PIN.
 */
export function letsSomeoneIn(r: LetInShape): boolean {
  if (r.letsIn) return true;
  if (r.notLetIn) return false;
  return letInKindsAt(r).length > 0;
}

/** What is wrong with a definition under these rules (empty: nothing). */
export function letInProblems(r: LetInShape): string[] {
  const id = r.id ?? `${r.method} ${r.path}`;
  const out: string[] = [];
  if (r.letsIn !== undefined && !(r.letsIn in LET_IN))
    out.push(`${id}: unknown let-in kind ${String(r.letsIn)}`);
  if (r.letsIn && r.notLetIn)
    out.push(`${id}: letsIn and notLetIn cannot both be set`);
  if (r.letsIn) {
    if (r.scope !== "daisy:grant")
      out.push(`${id}: a route that lets someone in (${r.letsIn}) must have scope daisy:grant`);
    if (r.pin === false)
      out.push(`${id}: a route that lets someone in (${r.letsIn}) must need the PIN`);
    if (r.pinOn !== undefined)
      out.push(`${id}: a route that lets someone in (${r.letsIn}) needs the PIN on every channel; no pinOn`);
    if (r.aiSelf)
      out.push(`${id}: a route that lets someone in (${r.letsIn}) cannot be open to the AI`);
    // D-40 ① (phase-4 gate): reading lets nobody in — a plain GET never
    // declares a kind (a socket still may: it fails closed); a read that
    // wants the PIN on the command line says so with `PIN_ON_CLI`.
    if (r.method === "GET" && !r.socket)
      out.push(`${id}: a read (GET) lets nobody in: no letsIn (a read that wants the PIN on the command line uses pinOn)`);
    const at = letInKindsAt(r);
    if (at.length && !at.includes(r.letsIn))
      out.push(`${id}: ${r.path} is kept for ${at.join(", ")}, not ${r.letsIn}`);
  } else if (r.notLetIn !== undefined) {
    // Why: the packs' `api.route.<id>.notLetIn` (tests/i18n-routes.test.ts).
  } else if (letInKindsAt(r).length)
    out.push(
      `${id}: ${r.method} ${r.path} is at a let-in place (${letInKindsAt(r).join(", ")}): set letsIn (forces daisy:grant + PIN), or notLetIn with the reason in the packs`,
    );
  // A change scoped daisy:grant is 「放别人进来」 unless it says why not.
  else if (r.scope === "daisy:grant" && r.method !== "GET")
    out.push(`${id}: a change scoped daisy:grant must set letsIn (or notLetIn, with the reason in the packs)`);
  // D-40 ①: the PIN on some channels only goes with the PIN.
  if (r.pinOn !== undefined && (!r.pin || !r.pinOn.length))
    out.push(`${id}: pinOn goes with pin: true and names at least one channel`);
  return out;
}
