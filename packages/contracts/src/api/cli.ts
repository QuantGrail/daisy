/**
 * P1-06 (ADR-107): the command-line metadata, derived from the route
 * table — what P1-07's `daisy` program reads to build its subcommands,
 * their arguments and their help. Nothing here is written twice: a new
 * route with a `cli` command is a new subcommand.
 */
import type { AnyRoute, Channel, Method, RouteTextSource } from "./route.ts";
import { describedText, documentedBody, isExempt, pathParams, pinFor, routeText } from "./route.ts";
import { limitsText, objectFields, type FieldInfo } from "./schema-info.ts";

export interface CliParam extends FieldInfo {
  /** Where the value goes in the request. */
  in: "params" | "query" | "body";
  /** `--kebab-case` (options only). */
  flag?: string;
  /**
   * How the command gets the value: `value` — from the argument / option;
   * `prompt` — a credential (`input: "secret"`): from standard input when
   * piped, else a prompt that does not echo, never from the command line;
   * `file` — the option takes a path, the command sends the file's content
   * (base64).
   */
  source: "value" | "prompt" | "file";
}

/**
 * P1-07's own commands, not routes (local-api.md §1): they work when the
 * process is not running, or do more than one call. A command of the
 * table never starts with one of these words (tests/api-defs.test.ts), so
 * merging the two sets never puts a leaf under a leaf.
 */
export const LOCAL_COMMANDS = [
  "start",
  "stop",
  "status",
  "open",
  "update",
  "doctor",
  "uninstall",
  "autostart",
  // P2-03: follows the event outlet (many calls, keeps running).
  "watch",
] as const;

export interface CliCommandMeta {
  /** `["session", "cancel"]` → `daisy session cancel`. */
  path: readonly string[];
  /** The route it calls (`session.cancel`). */
  route: string;
  method: Method;
  httpPath: string;
  /* Its summary and description: the packs' `api.route.<route>.*` (`routeText`). */
  /** In order: `daisy session cancel <id>`. */
  args: CliParam[];
  options: CliParam[];
  /**
   * The body is not a plain object (a union, a record…): the command
   * takes it whole as JSON (`--json '<body>'`).
   */
  rawBody: boolean;
  /** The body has an idempotency key the command generates. */
  idempotent: boolean;
  /** Its field (`requestId`, or e.g. `id` for terminal input). */
  idempotencyKey?: string;
  /** Ask for the PIN in the terminal first (local-api.md §6). */
  pin: boolean;
  /** What the answer is: JSON to print, or bytes to save (P1-07). */
  output: "json" | "binary" | "websocket";
  scope: string | null;
  channels: readonly Channel[];
  deprecated?: string;
}

export const kebab = (s: string) =>
  s.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase()).replace(/_/g, "-");

/** One route's command, or null when it is exempt. */
export function cliCommandOf(r: AnyRoute): CliCommandMeta | null {
  if (isExempt(r.cli)) return null;
  const fields: CliParam[] = [];
  const body = documentedBody(r);
  for (const where of ["params", "query", "body"] as const) {
    const f = objectFields(where === "body" ? body : r[where]);
    // A path parameter is always given.
    for (const x of f ?? [])
      fields.push({
        ...x,
        in: where,
        source: x.input === "secret" ? "prompt" : x.input === "file" ? "file" : "value",
        ...(where === "params" ? { required: true } : {}),
      });
  }
  const rawBody = !!body && objectFields(body) === null;
  const argNames = r.cli.args ?? pathParams(r.path);
  // By name, the first of params → query → body (a body field named like
  // a path parameter stays an option).
  const args = argNames.map((n) => {
    const f = fields.find((x) => x.name === n);
    if (!f) throw new Error(`${r.id}: command argument ${n} is not a field of this route`);
    if (f.source === "prompt")
      throw new Error(`${r.id}: credential ${n} cannot be a positional argument`);
    return f;
  });
  const options = fields
    .filter((f) => !args.includes(f))
    // The command fills the idempotency key itself.
    .filter((f) => !(f.in === "body" && f.name === r.idempotencyKey))
    .map((f) => ({ ...f, flag: "--" + kebab(f.name) }));
  return {
    path: r.cli.command,
    route: r.id,
    method: r.method,
    httpPath: r.path,
    args,
    options,
    rawBody,
    idempotent: !!r.idempotencyKey,
    ...(r.idempotencyKey ? { idempotencyKey: r.idempotencyKey } : {}),
    // D-40 ①: the command line asks when its own channel needs the PIN.
    pin: pinFor(r, "cli"),
    output: r.output.kind,
    scope: r.scope,
    channels: r.channels,
  };
}

/** Every command of the table, sorted by command path. */
export function cliCommands(routes: readonly AnyRoute[]): CliCommandMeta[] {
  return routes
    .map(cliCommandOf)
    .filter((c): c is CliCommandMeta => !!c)
    .sort((a, b) => a.path.join(" ").localeCompare(b.path.join(" ")));
}

/** Routes with no command (原则 6's exemptions); why: `api.route.<id>.exempt`. */
export function cliExemptions(routes: readonly AnyRoute[]) {
  return routes
    .filter((r) => isExempt(r.cli))
    .map((r) => ({
      route: r.id,
      method: r.method,
      path: r.path,
    }));
}

export interface CliNode {
  name: string;
  /** A leaf: the command this name runs. */
  command?: CliCommandMeta;
  children: CliNode[];
}

/** The subcommand tree (`daisy` → `session` → `cancel`). */
export function cliTree(routes: readonly AnyRoute[]): CliNode {
  const root: CliNode = { name: "daisy", children: [] };
  for (const c of cliCommands(routes)) {
    let at = root;
    for (const name of c.path) {
      let next = at.children.find((n) => n.name === name);
      if (!next) at.children.push((next = { name, children: [] }));
      at = next;
    }
    at.command = c;
  }
  return root;
}

const usageOf = (c: CliCommandMeta, t: RouteTextSource) =>
  [
    "daisy",
    ...c.path,
    ...c.args.map((a) => (a.required ? `<${a.name}>` : `[${a.name}]`)),
    ...(c.options.length ? [t.dynamic("cli.cmd.usageOptions")] : []),
    ...(c.rawBody ? [`--json ${t.dynamic("cli.cmd.bodyPlaceholder")}`] : []),
  ].join(" ");

/** A field's description in the translator's language (its `.describe()` key). */
export const fieldText = (f: Pick<FieldInfo, "description">, t: RouteTextSource): string =>
  describedText(f.description, t) ?? "";

const fieldLine = (f: CliParam, label: string, t: RouteTextSource) => {
  const how =
    f.source === "prompt"
      ? t.dynamic("cli.cmd.field.prompt")
      : f.source === "file"
        ? t.dynamic("cli.cmd.field.file")
        : "";
  const meta = [how || f.type, limitsText(f.limits, t), f.required ? t.dynamic("cli.cmd.field.required") : ""]
    .filter(Boolean)
    .join(t.dynamic("cli.list.comma"));
  return `  ${label.padEnd(24)} ${fieldText(f, t)}${t.dynamic("cli.cmd.field.meta", { meta })}`;
};

/** `--help` of one command, in the translator's language. */
export function cliHelp(c: CliCommandMeta, t: RouteTextSource): string {
  const lines = [t.dynamic("cli.cmd.usage", { usage: usageOf(c, t) }), "", routeText(c.route, "summary", t)!];
  const description = routeText(c.route, "description", t);
  if (description) lines.push("", description);
  if (c.args.length) {
    lines.push("", t.dynamic("cli.cmd.arguments"));
    for (const a of c.args) lines.push(fieldLine(a, `<${a.name}>`, t));
  }
  if (c.options.length) {
    lines.push("", t.dynamic("cli.cmd.options"));
    for (const o of c.options)
      lines.push(
        fieldLine(o, o.source === "file" ? `${o.flag} ${t.dynamic("cli.cmd.filePlaceholder")}` : o.flag!, t),
      );
  }
  const notes = [
    c.pin ? t.dynamic("cli.cmd.needsPin") : "",
    c.idempotent ? t.dynamic("cli.cmd.idempotent") : "",
  ].filter(Boolean);
  if (notes.length) lines.push("", ...notes);
  lines.push("", t.dynamic("cli.cmd.route", { method: c.method, path: c.httpPath, route: c.route }));
  return lines.join("\n");
}
