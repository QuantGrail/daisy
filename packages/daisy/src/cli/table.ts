/**
 * P1-07: the commands generated from the route table (ADR-107 §3). One
 * runner for all of them: the definition says which words are positional
 * arguments, which are options, which fields are credentials (read from a
 * prompt, never the command line), which are files, whether the command
 * fills an idempotency key and whether it needs the PIN. Nothing here is
 * per command, except the few interactive touches in `EXTRAS`.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  cliHelp,
  fieldText,
  fillPath,
  type CliCommandMeta,
  type CliParam,
} from "../../../contracts/src/index.ts";
import { CliError, usageError } from "./errors.ts";
import { PIN_GRANT_HEADER } from "../access/pin-seam.ts";
import { apiError, Daisy, locate, readCredential, type Ctx } from "./daisy.ts";
import { t } from "./lang.ts";
import { api } from "../../../contracts/src/api/index.ts";
import { chooseLanguage, languageView } from "../platform/language.ts";

/** What a command line turned into, before any request. */
export interface Parsed {
  params: Record<string, string>;
  query: Record<string, unknown>;
  body: Record<string, unknown> | unknown;
  /** Credentials to read at run time (fields with `source: prompt`). */
  prompts: CliParam[];
  idempotencyKey?: string;
  /** `--output <file>` for a binary answer. */
  output?: string;
  help: boolean;
}

const isArray = (f: CliParam) => /\[\]$/.test(f.type);
const isNumber = (f: CliParam) => /(^|\| )(integer|number)( |$)/.test(f.type);
const isBoolean = (f: CliParam) => /(^|\| )boolean( \||$)/.test(f.type) || /^(true|false)$/.test(f.type);
const isJsonish = (f: CliParam) => /^(object|Record<|any)/.test(f.type) || f.type.includes("object");

/** One value from the command line, typed by the field's schema. */
export function coerce(f: CliParam, raw: string, label: string): unknown {
  if (raw === "null" && /\bnull\b/.test(f.type)) return null;
  if (isJsonish(f) && !isArray(f)) {
    try {
      return JSON.parse(raw);
    } catch {
      throw usageError(t("cli.table.notJson", { label, type: f.type, raw: raw.slice(0, 60) }), t("cli.table.notJsonFix", { label }));
    }
  }
  if (isNumber(f) && !isBoolean(f)) {
    const n = Number(raw);
    if (raw.trim() === "" || !Number.isFinite(n))
      throw usageError(t("cli.table.notNumber", { label, type: f.type, raw: raw.slice(0, 60) }), t("cli.table.numberFix", { label }));
    if (/integer/.test(f.type) && !Number.isInteger(n))
      throw usageError(t("cli.table.notInteger", { label, raw }), t("cli.table.numberFix", { label }));
    return n;
  }
  if (isBoolean(f)) {
    if (/^(true|yes|on|1)$/i.test(raw)) return true;
    if (/^(false|no|off|0)$/i.test(raw)) return false;
    throw usageError(t("cli.table.notBoolean", { label, raw }), t("cli.table.booleanFix", { label }));
  }
  if (f.enum && f.enum.length && !f.enum.includes(raw) && !f.enum.some((v) => String(v) === raw))
    throw usageError(
      t("cli.table.notEnum", { label, values: f.enum.map((v) => JSON.stringify(v)).join(t("cli.list.separatorShort")), raw: raw.slice(0, 60) }),
      t("cli.table.enumFix", { label, example: String(f.enum[0]) }),
    );
  if (f.enum && f.enum.length && typeof f.enum[0] !== "string") {
    const hit = f.enum.find((v) => String(v) === raw);
    if (hit !== undefined) return hit;
  }
  return raw;
}

function setField(p: Parsed, f: CliParam, v: unknown) {
  if (f.in === "params") p.params[f.name] = String(v);
  else if (f.in === "query") p.query[f.name] = v;
  else (p.body as Record<string, unknown>)[f.name] = v;
}

/** The command line (after the command's words) → request parts. */
export async function parseArgs(c: CliCommandMeta, argv: string[], ctx: Ctx): Promise<Parsed> {
  const p: Parsed = { params: {}, query: {}, body: {}, prompts: [], help: false };
  const positional: string[] = [];
  const arrays = new Map<CliParam, unknown[]>();
  const byFlag = new Map(c.options.map((o) => [o.flag!, o]));
  let json: unknown;
  let jsonFromArgv = false;
  let lastSecretFlag: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (a === "-h" || a === "--help") {
      p.help = true;
      continue;
    }
    if (!a.startsWith("--") || a === "-") {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    const name = eq > 0 ? a.slice(0, eq) : a;
    const inline = eq > 0 ? a.slice(eq + 1) : undefined;
    const value = () => {
      if (inline !== undefined) return inline;
      const v = argv[i + 1];
      if (v === undefined || (v.startsWith("--") && v !== "--"))
        throw usageError(t("cli.table.missingValue", { name }), t("cli.table.missingValueFix", { name }));
      i++;
      return v;
    };
    if (name === "--json") {
      const v = value();
      if (v === "-") json = parseJson(await ctx.io.readAll(), t("cli.table.stdin"));
      else if (v.startsWith("@")) json = parseJson(readFile(v.slice(1)).toString("utf8"), v.slice(1));
      else {
        json = parseJson(v, "--json");
        jsonFromArgv = true;
      }
      continue;
    }
    if (name === "--idempotency-key" && c.idempotent && !byFlag.has(name)) {
      p.idempotencyKey = value();
      continue;
    }
    if (name === "--output" && !byFlag.has(name)) {
      p.output = value();
      continue;
    }
    const negated = name.startsWith("--no-") ? byFlag.get("--" + name.slice(5)) : undefined;
    if (negated && isBoolean(negated) && inline === undefined) {
      setField(p, negated, false);
      continue;
    }
    const f = byFlag.get(name);
    if (!f) {
      const all = [...byFlag.keys(), ...(c.rawBody || c.options.some((o) => o.in === "body") ? ["--json"] : [])];
      throw usageError(
        t("cli.table.noOption", { cmd: c.path.join(" "), name }),
        all.length ? t("cli.table.options", { options: all.join(t("cli.list.separatorShort")) }) : t("cli.table.noOptions"),
      );
    }
    if (f.source === "prompt") {
      // A credential never comes from the command line (shell history, ps).
      if (inline !== undefined)
        throw secretOnCommandLine(f);
      lastSecretFlag = name;
      if (!p.prompts.includes(f)) p.prompts.push(f);
      continue;
    }
    if (f.source === "file") {
      const path = value();
      setField(p, f, readFile(path).toString("base64"));
      continue;
    }
    if (isBoolean(f) && !isNumber(f) && inline === undefined) {
      const next = argv[i + 1];
      if (next !== undefined && /^(true|false)$/i.test(next)) {
        i++;
        setField(p, f, /^true$/i.test(next));
      } else setField(p, f, true);
      continue;
    }
    const raw = value();
    if (isArray(f)) {
      // Repeat the option, or give a JSON array once.
      const list = arrays.get(f) ?? [];
      if (raw.trim().startsWith("[")) list.push(...(parseJson(raw, name) as unknown[]));
      else list.push(f.type === "string[]" ? raw : coerce({ ...f, type: f.type.replace(/\[\]$/, "") }, raw, name));
      arrays.set(f, list);
      continue;
    }
    setField(p, f, coerce(f, raw, name));
  }
  if (p.help) return p;
  for (const [f, list] of arrays) setField(p, f, list);

  // Positional arguments, in order.
  if (positional.length > c.args.length) {
    const extra = positional.slice(c.args.length);
    if (lastSecretFlag)
      throw secretOnCommandLine(c.options.find((o) => o.flag === lastSecretFlag)!);
    throw usageError(
      t("cli.table.extraArgs", { args: extra.map((x) => JSON.stringify(x)).join(" ").slice(0, 120) }),
      t("cli.table.extraArgsFix", { cmd: c.path.join(" ") }),
    );
  }
  for (let k = 0; k < c.args.length; k++) {
    const f = c.args[k]!;
    const raw = positional[k];
    if (raw === undefined) {
      if (f.required)
        throw usageError(
          t("cli.table.missingArg", { name: f.name, what: f.description ? t("cli.table.what", { text: fieldText(f, t) }) : "" }),
          t("cli.table.missingArgFix", { cmd: c.path.join(" "), args: c.args.map((a) => `<${a.name}>`).join(" ") }),
        );
      continue;
    }
    const v = raw === "-" && f.type.includes("string") ? (await ctx.io.readAll()).replace(/\n$/, "") : raw;
    setField(p, f, coerce(f, v, `<${f.name}>`));
  }

  // --json: the whole body (a raw body), or a base the options override.
  if (json !== undefined) {
    if (c.method === "GET" || c.method === "DELETE")
      throw usageError(t("cli.table.noBody"), t("cli.table.noBodyFix"));
    if (c.rawBody) p.body = json;
    else {
      if (!json || typeof json !== "object" || Array.isArray(json))
        throw usageError(t("cli.table.jsonObject"), t("cli.table.jsonObjectFix"));
      const secrets = [...c.args, ...c.options].filter((f) => f.source === "prompt" && f.in === "body");
      const leaked = secrets.find((f) => f.name in (json as object));
      if (leaked && jsonFromArgv) throw secretOnCommandLine(leaked);
      p.body = { ...(json as object), ...(p.body as object) };
    }
  } else if (c.rawBody) {
    throw usageError(t("cli.table.rawBody"), t("cli.table.rawBodyFix", { cmd: c.path.join(" ") }));
  }
  // Required credentials are always asked for.
  for (const f of [...c.args, ...c.options])
    if (f.source === "prompt" && f.required && !p.prompts.includes(f)) p.prompts.push(f);
  // A required option missing → say so before asking anything.
  for (const f of c.options) {
    if (!f.required || f.source === "prompt") continue;
    const has =
      f.in === "query" ? f.name in p.query : f.in === "params" ? f.name in p.params : f.name in (p.body as object);
    if (!has)
      throw usageError(
        t("cli.table.missingOption", { flag: f.flag!, what: f.description ? t("cli.table.what", { text: fieldText(f, t) }) : "" }),
        t("cli.table.missingOptionFix", { flag: f.flag!, cmd: c.path.join(" ") }),
      );
  }
  return p;
}

function secretOnCommandLine(f: CliParam): CliError {
  return usageError(
    t("cli.table.secretOnLine", { name: f.flag ?? f.name }),
    t("cli.table.secretOnLineFix", { flag: f.flag ?? "" }),
  );
}

function parseJson(text: string, where: string): unknown {
  try {
    return JSON.parse(text);
  } catch (e: any) {
    throw usageError(t("cli.table.badJson", { where, message: e.message }), t("cli.table.badJsonFix"));
  }
}

function readFile(path: string): Buffer {
  try {
    return readFileSync(resolve(path));
  } catch (e: any) {
    throw new CliError(t("cli.table.readFile", { path, why: String(e?.code ?? e?.message) }), t("cli.table.readFileFix"), 2);
  }
}

/**
 * The few interactive touches beyond the definition (keyed by route id):
 * a new PIN is typed twice; an old one is asked for when Daisy says it is
 * needed.
 */
/**
 * Review M-1 (P4-01): before the PIN for `daisy contact import`, read the
 * card here and show whose it is — the name and the whole identity number
 * — with the hint to check the number with the other person (and to pass
 * it as --expect-id). A card that does not verify stops here, before the
 * PIN is asked for.
 */
async function previewCard(body: Record<string, unknown>, ctx: Ctx): Promise<void> {
  const text =
    typeof body.card === "string"
      ? body.card
      : typeof body.cardFile === "string"
        ? Buffer.from(body.cardFile, "base64").toString("utf8")
        : null;
  if (text === null) return;
  const { readCard } = await import("../contacts/card.ts");
  const { groupedId } = await import("../contacts/identity.ts");
  const { IDENTITY_CARD_LIMITS } = await import("../../../contracts/src/limits.ts");
  let card;
  try {
    card = await readCard(text);
  } catch (e) {
    throw new CliError((e as Error).message, t("cli.table.card.badFix"), 2, (e as any)?.code);
  }
  const n = IDENTITY_CARD_LIMITS.verifyChars;
  ctx.io.err(
    [
      t("cli.table.card.name", { name: card.name }),
      t("cli.table.card.id", { id: groupedId(card.id) }),
      t("cli.table.card.verify", { n }),
      body.expectId === undefined
        ? t("cli.table.card.expectHint", { prefix: card.id.slice(0, n) })
        : t("cli.table.card.expectGiven"),
    ].join("\n"),
  );
}

const EXTRAS: Record<
  string,
  {
    confirm?: string[];
    retryAsk?: Record<string, string>;
    print?: string;
    before?: (body: Record<string, unknown>, ctx: Ctx) => Promise<void>;
    /** Print the answer otherwise than as JSON. */
    render?: (data: any, ctx: Ctx) => void;
    /**
     * P6-28: what the command does itself while no Daisy runs for this
     * data directory (never started, stopped, or its process gone): the
     * route's answer, and a line saying so.
     */
    offline?: (body: Record<string, unknown>, ctx: Ctx) => { data: unknown; note: string };
  }
> = {
  "settings.pinSet": { confirm: ["pin"], retryAsk: { pin_old_required: "oldPin" } },
  // P4-01: the card is text to copy (identity-card.md §2), not JSON.
  "grant.contactExport": { print: "text" },
  "grant.contactImport": { before: previewCard },
  // P4-12 (token.md §7): the token alone on standard output (once — it is
  // not kept anywhere), what it is and the warning on standard error.
  "grant.tokenIssue": { render: renderIssuedToken },
  // P5-03 (ADR-142): the pairing code and its link, for a person to read.
  "settings.pair": { render: renderPairingCode },
  // P6-28: the display language is a setting in config.json — chosen and
  // shown before the first start too (the command line reads it from there anyway).
  "settings.languageShow": {
    offline: (_body, ctx) => ({
      data: languageView(ctx.dataDir),
      note: t("cli.language.offlineShow", { file: join(ctx.dataDir, "config.json") }),
    }),
  },
  "settings.languageSet": { offline: setLanguageOffline },
};

/** `daisy language set` while Daisy is not running: the route's check, written to config.json. */
function setLanguageOffline(body: Record<string, unknown>, ctx: Ctx): { data: unknown; note: string } {
  const b = api.settings.languageSet.body.safeParse(body);
  if (!b.success) throw apiError(400, { error: t("api.error.invalidInput"), code: "invalid_input" }, ctx.dataDir);
  mkdirSync(ctx.dataDir, { recursive: true, mode: 0o700 });
  if (!chooseLanguage(ctx.dataDir, b.data.language))
    throw apiError(400, { error: t("api.error.languageUnknown", { lang: String(b.data.language) }), code: "language_unknown" }, ctx.dataDir);
  return { data: languageView(ctx.dataDir), note: t("cli.language.offlineSet", { file: join(ctx.dataDir, "config.json") }) };
}

/**
 * P5-03b: the pairing code and its link — the direct listener's first, the
 * relay's as the alternative (review M-1), each with what to know; no link
 * at all for a relay with only a self-signed certificate (review L-1).
 */
export function renderPairingCode(data: any, ctx: Pick<Ctx, "io">): void {
  if (typeof data?.code !== "string" || (data.url !== null && typeof data.url !== "string")) {
    ctx.io.out(JSON.stringify(data, null, 2));
    return;
  }
  const mins = Math.max(1, Math.round((Number(data.expiresAt) - Date.now()) / 60_000));
  const words = (w: unknown) => (typeof w === "string" && w ? [t("cli.table.pair.note", { text: w })] : []);
  ctx.io.out(
    [
      t("cli.table.pair.code", { code: data.code }),
      ...(data.url ? [t(data.via === "relay" ? "cli.table.pair.linkRelay" : "cli.table.pair.link", { url: data.url })] : [t("cli.table.pair.noLink")]),
      ...words(data.warning),
      ...(typeof data.fingerprint === "string" && data.fingerprint ? [t("cli.table.pair.fingerprint", { fingerprint: data.fingerprint })] : []),
      ...(typeof data.relayUrl === "string" ? ["", t("cli.table.pair.relayUrl", { url: data.relayUrl })] : data.relayWarning ? [""] : []),
      ...words(data.relayWarning),
      "",
      data.url ? t("cli.table.pair.howLink") : t("cli.table.pair.howCode"),
      t("cli.table.pair.valid", { mins }),
    ].join("\n"),
  );
}

function renderIssuedToken(data: any, ctx: Ctx): void {
  const r = data?.record;
  if (typeof data?.token !== "string" || !r) {
    ctx.io.out(JSON.stringify(data, null, 2));
    return;
  }
  ctx.io.err(
    [
      t("cli.table.token.issued", {
        who: r.for?.kind === "me" ? t("cli.table.token.me") : String(r.for?.name),
        id: r.jti,
        expires: new Date(r.expiresAt).toISOString(),
      }),
      t("cli.table.token.how"),
      String(data.warning ?? ""),
    ].join("\n"),
  );
  ctx.io.out(data.token);
}

const promptOf = (f: CliParam) => t("cli.table.prompt", { what: f.description ? fieldText(f, t) : f.name });
const labelOf = (f: CliParam) => (f.description ? fieldText(f, t) : f.name);

/** Run a generated command. Returns the exit code. */
export async function runTableCommand(c: CliCommandMeta, argv: string[], ctx: Ctx): Promise<number> {
  const p = await parseArgs(c, argv, ctx);
  if (p.help) {
    ctx.io.out(cliHelp(c, t) + "\n\n" + OWN_HELP(c));
    return 0;
  }
  const extras = EXTRAS[c.route] ?? {};
  const body = p.body as Record<string, unknown>;
  if (extras.offline && locate(ctx.dataDir).state !== "running") {
    const { data, note } = extras.offline(body, ctx);
    ctx.io.err(note);
    ctx.io.out(JSON.stringify(data, null, 2));
    return 0;
  }
  const daisy = Daisy.connect(ctx);
  for (const f of p.prompts) {
    const v = await readCredential(ctx.io, promptOf(f), labelOf(f));
    if (extras.confirm?.includes(f.name)) {
      const again = await readCredential(ctx.io, t("cli.table.again"), t("cli.table.againLabel", { what: labelOf(f) }));
      if (again !== v) throw new CliError(t("cli.table.mismatch"), t("cli.table.mismatchFix"));
    }
    setField(p, f, v);
  }
  if (c.idempotent && c.idempotencyKey && c.method !== "GET")
    body[c.idempotencyKey] = p.idempotencyKey ?? (body[c.idempotencyKey] as string) ?? randomUUID();
  const headers: Record<string, string> = {};
  if (extras.before) await extras.before(body, ctx);
  if (c.pin) headers[PIN_GRANT_HEADER] = await daisy.pinGrant();
  const path = fillPath(c.httpPath, p.params);
  const binary = c.output === "binary";
  const send = () =>
    daisy.call(c.method, path, {
      query: p.query,
      ...(c.method === "GET" || c.method === "DELETE" ? {} : { body }),
      headers,
      binary,
    });
  let reply;
  try {
    reply = await send();
  } catch (e) {
    const ask = e instanceof CliError && e.code ? extras.retryAsk?.[e.code] : undefined;
    const f = ask ? [...c.args, ...c.options].find((x) => x.name === ask) : undefined;
    if (f) {
      ctx.io.err(`${e instanceof Error ? e.message : ""}`);
      setField(p, f, await readCredential(ctx.io, promptOf(f), labelOf(f)));
      reply = await send();
    } else {
      if (e instanceof CliError && e.code === "not_running" && c.idempotent && c.idempotencyKey)
        e.fix += t("cli.table.resendHint", { key: String(body[c.idempotencyKey]) });
      throw e;
    }
  }
  if (binary) {
    const bytes = reply.bytes ?? new Uint8Array();
    if (p.output) {
      writeFileSync(resolve(p.output), bytes, { mode: 0o600 });
      ctx.io.err(t("cli.table.saved", { path: resolve(p.output), bytes: bytes.length }));
    } else if (ctx.io.stdoutTTY)
      throw new CliError(t("cli.table.binary"), t("cli.table.binaryFix"));
    else ctx.io.write(bytes);
    return 0;
  }
  if (extras.render) {
    extras.render(reply.data, ctx);
    return 0;
  }
  const text = extras.print ? reply.data?.[extras.print] : undefined;
  if (typeof text === "string") ctx.io.out(text);
  else ctx.io.out(reply.data === null || reply.data === "" ? t("cli.table.done") : JSON.stringify(reply.data, null, 2));
  return 0;
}

/** The generated command's own options, appended to its help. */
export function OWN_HELP(c: CliCommandMeta): string {
  const lines = [t("cli.table.own.title")];
  if (c.rawBody) lines.push(t("cli.table.own.jsonBody"));
  else if (c.method !== "GET" && c.method !== "DELETE" && (c.options.some((o) => o.in === "body") || c.args.some((a) => a.in === "body")))
    lines.push(t("cli.table.own.jsonObject"));
  if (c.idempotent) lines.push(t("cli.table.own.idempotencyKey"));
  if (c.output === "binary") lines.push(t("cli.table.own.output"));
  lines.push(t("cli.table.own.help"));
  lines.push("", t("cli.table.own.answer"));
  return lines.join("\n");
}
