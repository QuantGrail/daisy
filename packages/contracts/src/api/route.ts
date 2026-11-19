/**
 * P1-06 (ADR-107): one definition per local API route. The server
 * registers its routes from these definitions and validates with their
 * schemas; the API docs (docs/api/), the command-line metadata (cli.ts,
 * for P1-07) and the client's types all come from the same table.
 */
import { z } from "zod";
import { letInProblems, type LetInKind } from "./let-in.ts";
import { API_TEXT_PARAMS } from "./text-params.ts";

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * scopes.md §1 (5.11). Checked from P1-03 on; null = no token needed.
 * P2-03 (README 待决点 2, recommendation B under D-35): a seventh,
 * `daisy:events:read` — the event outlet only, never a conversation.
 */
export const SCOPES = [
  "daisy:session:read",
  "daisy:session:write",
  "daisy:tools",
  "daisy:invoke",
  "daisy:manage",
  "daisy:grant",
  "daisy:events:read",
] as const;
export type Scope = (typeof SCOPES)[number];

/**
 * Where a call may come from (token.md §3): the owner's local web page,
 * a paired device, the command line, an AI's working credential, and
 * (P2-01, token.md §4.2) a token the configured external issuer signed
 * for the owner — 「主人本人」 from elsewhere (X-1, no pairing).
 */
export type Channel = "web" | "device" | "cli" | "ai" | "issuer";
/** The owner's own channels (5.11 「主人本人」 and 「命令行」). */
export type OwnerChannel = Exclude<Channel, "ai">;
export const OWNER_CHANNELS: readonly OwnerChannel[] = ["web", "device", "cli", "issuer"];

/**
 * How a call proves who it is when not by `Authorization: Bearer`
 * (P1-03, ADR-110): `socket-first-frame` — the live socket's first frame
 * carries the credential; `one-time-code` — the web page trades a
 * one-time code (`daisy open`) for its session, or, on this machine with
 * the passcode off, a same-origin page asks for one with none.
 * P5-03: `pairing-code` — another device trades a pairing code (`daisy
 * pair`, PIN) for its device credential; `device-secret` — a paired
 * device trades that credential for a new device session.
 */
export type AuthMode = "socket-first-frame" | "one-time-code" | "pairing-code" | "device-secret";

/**
 * P1-03 (D-31, ADR-101): on the outside face, opening a terminal, running
 * a command and browsing this machine's folders are off until the owner
 * turns them on (with the PIN). A route of one of these kinds names it.
 */
export type ExternalGate = "terminal" | "shell" | "browse";
export const EXTERNAL_GATES: readonly ExternalGate[] = [
  "terminal",
  "shell",
  "browse",
];

/** 5.10's groups of the local API, and the event outlet (P2-03). */
export type ApiGroup =
  | "session"
  | "approval"
  | "profile"
  | "workspace"
  | "grant"
  | "settings"
  | "attachment"
  | "system"
  | "events"
  /** P4-04: the A2A entry — other agents, never the owner's local API. */
  | "a2a";

/** What a route answers with. `T` is the TypeScript type (client side). */
export interface Output<T = unknown> {
  kind: "json" | "binary" | "websocket";
  /** How the docs name it (a contracts type, or a short description). */
  name: string;
  /** A zod schema of the answer, where the contracts have one. */
  schema?: z.ZodType<T>;
  /** Phantom: carries `T` for ApiOutput; never set at run time. */
  readonly __type?: T;
}
/** JSON answer typed by a contracts type (no zod schema of it yet). */
export function json<T>(name: string): Output<T>;
/** JSON answer described by a zod schema. */
export function json<S extends z.ZodType>(
  schema: S,
  name?: string,
): Output<z.output<S>>;
export function json(a: any, name?: string): Output<any> {
  return typeof a === "string"
    ? { kind: "json", name: a }
    : { kind: "json", name: name ?? "JSON", schema: a };
}
/** A file / byte stream (attachment download, client build). */
export const binary = (name: string): Output<Blob> => ({ kind: "binary", name });
/** A WebSocket upgrade (the live push channel). */
export const websocket = (name: string): Output<never> => ({
  kind: "websocket",
  name,
});

/**
 * How a client should take a field's value (`x-daisy-input` in its JSON
 * Schema): `secret` — a credential, never a command-line argument (it would
 * land in shell history and `ps`): read from standard input or a hidden
 * prompt; `file` — the field carries a file's content (base64): the command
 * takes a path and reads the file. Validation is unchanged.
 */
export type InputKind = "secret" | "file";
export const INPUT_KEY = "x-daisy-input";
export const secretInput = <S extends z.ZodType>(s: S): S =>
  s.meta({ [INPUT_KEY]: "secret" }) as S;
export const fileInput = <S extends z.ZodType>(s: S): S =>
  s.meta({ [INPUT_KEY]: "file" }) as S;

/** The command a route becomes (`daisy <command…> <args…> --<option>`). */
export interface CliCommand {
  command: readonly string[];
  /**
   * Positional arguments, by field name (from params, then query / body).
   * Default: the path parameters in path order. Every other field of
   * params / query / body becomes a `--kebab-case` option.
   */
  args?: readonly string[];
}
/**
 * A route with no command of its own (原则 6). Why is the pack text
 * `api.route.<id>.exempt` (P6-23a, ADR-159 §7; a test requires it), or
 * the pack key given here when several routes share one reason.
 */
export interface CliExempt {
  exempt: true | string;
}
export type Cli = CliCommand | CliExempt;
export const cmd = (
  command: string,
  more: Omit<CliCommand, "command"> = {},
): CliCommand => ({ command: command.split(" ").filter(Boolean), ...more });
export const exempt = (sharedKey?: string): CliExempt => ({ exempt: sharedKey ?? true });
export const isExempt = (c: Cli): c is CliExempt => "exempt" in c;

/** Names of `:param`s in a path template. */
export type PathParams<P extends string> =
  P extends `${string}:${infer N}/${infer Rest}`
    ? N | PathParams<`/${Rest}`>
    : P extends `${string}:${infer N}`
      ? N
      : never;

export interface RouteSpec<
  P extends string = string,
  Q extends z.ZodType | undefined = z.ZodType | undefined,
  B extends z.ZodType | undefined = z.ZodType | undefined,
  O = unknown,
> {
  method: Method;
  path: P;
  /*
   * P6-23a (ADR-159 §7): a route's text is in the language packs, never
   * here — `api.route.<id>.summary` (one line: the command's help line and
   * the docs' heading; required), `.description` (optional), `.exempt`
   * (why `cli: exempt()`), `.notLetIn` (why `notLetIn: true`), `.auditWhy`
   * (why `audit: false`), `.removal` (why `removal`). Field descriptions:
   * `.describe("<key>")` with an `api.*` key (`routeFieldText`).
   */
  /** scopes.md; null = public (no token). */
  scope: Scope | null;
  /** “放别人进来”: also needs a PIN grant (local-api.md §6). Default false. */
  pin?: boolean;
  /**
   * D-40 ① (phase-4 gate): the PIN only on these of the owner's channels.
   * The 「调用授权」 reads take it on the command line only (`PIN_ON_CLI`):
   * the command line's credential may be the owner's AI through Bash
   * (ADR-110), the web page, a paired device and the external issuer's
   * token for the owner cannot. Unset: on every channel. Never with
   * `letsIn` (letting someone in takes the PIN everywhere).
   */
  pinOn?: readonly OwnerChannel[];
  /**
   * P4-02 (5.11, let-in.ts): this route lets someone else in — which of
   * 5.11's 「放别人进来」 rows. Forces `pin: true`; the scope must be
   * `daisy:grant` and the AI never reaches it (checked by `group`, by
   * `serve`, and again by the guard).
   */
  letsIn?: LetInKind;
  /**
   * P4-02: a change at a place reserved for 「放别人进来」 routes (the
   * 「调用授权」 and settings groups, a path with let-in.ts `LET_IN_WORDS`),
   * or scoped `daisy:grant`,
   * that lets nobody in. Why is the pack text `api.route.<id>.notLetIn`
   * (shown in the docs; the PIN routes themselves, a pause that only stops
   * calls…).
   */
  notLetIn?: true;
  /**
   * Which of the owner's channels may call it, on top of the scope.
   * Default all four (web, paired device, command line, the external
   * issuer's token for the owner). Answering the AI's tool approvals and
   * questions is `["web", "device"]` (5.11, 原则 6: the owner in person —
   * never the command line; the external issuer's token neither, until
   * the owner decides otherwise — ADR-113).
   * `[]` with `aiSelf`: the AI's own tools only (P2-02's `session.aiToken`).
   */
  channels?: readonly OwnerChannel[];
  /**
   * 5.11: an AI's working credential reads only its own session. Routes
   * it may call name the path parameter that holds that session's id
   * here; every other route is closed to the `ai` channel.
   */
  aiSelf?: string;
  /** Authenticated otherwise than by a Bearer token (see AuthMode). */
  auth?: AuthMode;
  /**
   * P4-04 (5.11 「外面来的」, token.md §4.1 step 9, X-2): the A2A entry —
   * reachable by visitors (a contact's cross-Daisy token, the external
   * issuer's token for someone else) and by nobody else: the owner's
   * channels and the AI get 403 `visitors_only`. Every other route
   * refuses a visitor (`a2a_only`). Set `channels: []` with it.
   */
  visitors?: true;
  /**
   * P1-03: off on the outside face unless the owner turned this kind on
   * (see ExternalGate). The local face is not affected.
   */
  external?: ExternalGate;
  /**
   * A body field is an idempotency key: a resend gets the first call's
   * result (原则 2, R-2; local-api.md §5). `true` = `requestId`; or the
   * field's name. The command line fills it itself.
   */
  idempotent?: true | string;
  /**
   * Path parameters. Default: each `:name` a string. Given only to
   * describe them (the server reads them as before).
   */
  params?: z.ZodObject;
  query?: Q;
  body?: B;
  /**
   * When the handler checks the body in two steps (a first look with
   * `body`, the rest where the work is done), the schema the body finally
   * has to satisfy. The docs and the command line read it instead of `body`.
   */
  bodyFull?: z.ZodType;
  output: Output<O>;
  /** Machine-readable `code`s this route may answer with. */
  errors?: readonly string[];
  cli: Cli;
  /** Planned removal: the work package (why: `api.route.<id>.removal`, shown in the docs). */
  removal?: { by: string };
  /**
   * P1-11 (S-4): record every call in the audit — who, face, channel,
   * route, object, outcome, trace id. Default: every method but GET (an
   * action); a read worth knowing about (the audit itself) sets `true`, an
   * action too fine-grained to keep (keystrokes) sets `false` with a
   * reason in the pack (`api.route.<id>.auditWhy`). A refusal is always
   * recorded (ADR-110 §6).
   */
  audit?: boolean;
}

export interface RouteDef<
  P extends string = string,
  Q extends z.ZodType | undefined = z.ZodType | undefined,
  B extends z.ZodType | undefined = z.ZodType | undefined,
  O = unknown,
> extends Omit<RouteSpec<P, Q, B, O>, "channels"> {
  /** `<group>.<key>`, unique: the docs anchor and the handle in tests. */
  id: string;
  group: ApiGroup;
  params: z.ZodObject;
  pin: boolean;
  /** The owner channels, plus `ai` when `aiSelf` is set. */
  channels: readonly Channel[];
  /** The body field that is the idempotency key, if any. */
  idempotencyKey?: string;
  /** Successful calls are audited (RouteSpec.audit, defaulted). */
  audit: boolean;
}
export type AnyRoute = RouteDef<string, any, any, any>;

/**
 * D-40 ①: a read of the 「调用授权」 group — no PIN on the web page, a
 * paired device or the issuer's token for the owner; the PIN on the
 * command line (whose credential may be the owner's AI). Spread into a
 * route's spec.
 */
export const PIN_ON_CLI = { pin: true, pinOn: ["cli"] } as const satisfies Pick<RouteSpec, "pin" | "pinOn">;

/** Does this route ask a caller on `channel` for the PIN? */
export const pinFor = (r: Pick<AnyRoute, "pin" | "pinOn">, channel: string): boolean =>
  r.pin && (!r.pinOn || (r.pinOn as readonly string[]).includes(channel));

/** The body as the docs and the command line describe it. */
export const documentedBody = (r: AnyRoute): z.ZodType | undefined =>
  r.bodyFull ?? r.body;

/** Path parameter names, in path order. */
export const pathParams = (path: string): string[] =>
  [...path.matchAll(PARAM)].map((m) => m[1]!);
/**
 * A `:name` parameter; `::` is the router's escaped literal colon (A2A's
 * `message:send` is written `message::send`), never a parameter.
 */
const PARAM = /(?<!:):([A-Za-z_][A-Za-z0-9_]*)/g;
/** A path as sent: the router's `::` is one literal `:`. */
export const literalPath = (path: string) => path.replace(/::/g, ":");

/**
 * One route's definition (completed with its id and group by `group`).
 * The generics keep each schema's own type, so `def.body.parse(…)` is
 * typed and the client derives its arguments and answer.
 */
export function route<
  const P extends string,
  Q extends z.ZodType | undefined = undefined,
  B extends z.ZodType | undefined = undefined,
  O = unknown,
>(spec: RouteSpec<P, Q, B, O>): RouteSpec<P, Q, B, O> {
  return spec;
}

type Completed<T> = {
  [K in keyof T]: T[K] extends RouteSpec<infer P, infer Q, infer B, infer O>
    ? Omit<RouteDef<P, Q, B, O>, "query" | "body"> & { query: Q; body: B }
    : never;
};

/** A group of routes: ids become `<group>.<key>`; params default from the path. */
export function group<const T extends Record<string, RouteSpec<any, any, any, any>>>(
  name: ApiGroup,
  specs: T,
): Completed<T> {
  const out: Record<string, AnyRoute> = {};
  for (const [key, s] of Object.entries(specs)) {
    const names = pathParams(s.path);
    // P4-02: a route that lets someone in is daisy:grant + PIN, or it is
    // not defined at all (fails at load: nobody can ship it by mistake).
    const problems = letInProblems({
      ...s,
      id: `${name}.${key}`,
      group: name,
      socket: s.output.kind === "websocket",
    });
    if (problems.length) throw new Error(problems.join("\n"));
    out[key] = {
      ...s,
      id: `${name}.${key}`,
      group: name,
      pin: s.letsIn ? true : (s.pin ?? false),
      audit: s.audit ?? s.method !== "GET",
      channels: [...(s.channels ?? OWNER_CHANNELS), ...(s.aiSelf ? ["ai" as const] : [])],
      ...(s.idempotent
        ? { idempotencyKey: s.idempotent === true ? "requestId" : s.idempotent }
        : {}),
      params:
        s.params ??
        z.object(Object.fromEntries(names.map((n) => [n, z.string()]))),
    };
  }
  return out as Completed<T>;
}

// ── what a client derives from a definition ─────────────────────────────
export type ApiParams<D extends AnyRoute> = {
  [K in PathParams<D["path"]>]: string;
};
export type ApiQuery<D extends AnyRoute> = D["query"] extends z.ZodType
  ? z.input<D["query"]>
  : never;
export type ApiBody<D extends AnyRoute> = D["body"] extends z.ZodType
  ? z.input<D["body"]>
  : never;
export type ApiOutput<D extends AnyRoute> =
  D["output"] extends Output<infer T> ? T : unknown;
/** The one argument of `client.call(def, input)`. */
export type ApiInput<D extends AnyRoute> = ([PathParams<D["path"]>] extends [
  never,
]
  ? {}
  : { params: ApiParams<D> }) &
  (D["query"] extends z.ZodType ? { query?: ApiQuery<D> } : {}) &
  (D["body"] extends z.ZodType ? { body: ApiBody<D> } : {});

/** `/api/sessions/:id` with `{ id }` filled in (each value URI-encoded). */
export function fillPath(path: string, params: Record<string, string> = {}) {
  return literalPath(
    path.replace(PARAM, (_, n: string) => {
      const v = params[n];
      if (v === undefined) throw new Error(`missing path parameter ${n} (${path})`);
      return encodeURIComponent(v);
    }),
  );
}

// ── P6-20 / P6-23a (ADR-159 §7): a route's text in a language ──────────
/** What a route-text lookup needs of a translator (`Translate` fits). */
export interface RouteTextSource {
  readonly lang?: string;
  has(key: string): boolean;
  dynamic(key: string, params?: Record<string, unknown>): string;
}
/** The parts of a route's text in the packs (`api.route.<id>.<part>`). */
export type RouteTextPart = "summary" | "description" | "exempt" | "notLetIn" | "auditWhy" | "removal";
export const ROUTE_TEXT_PARTS: readonly RouteTextPart[] = ["summary", "description", "exempt", "notLetIn", "auditWhy", "removal"];
/** The pack key of a route's text: `api.route.<id>.summary`, `.description`, … */
export const routeTextKey = (id: string, part: RouteTextPart) => `api.route.${id}.${part}`;
/**
 * A route's text in the translator's language; undefined when the pack
 * has none (an optional part). A required part that is missing (a test
 * failure) shows its key, never a crash.
 */
export function routeText(id: string, part: RouteTextPart, t: RouteTextSource): string | undefined {
  const key = routeTextKey(id, part);
  return t.has(key) ? t.dynamic(key, API_TEXT_PARAMS) : part === "summary" ? key : undefined;
}
/**
 * A field description (`.describe("<key>")`, a JSON Schema `description`)
 * in the translator's language: a pack key is translated, anything else
 * (a schema from outside the table) is shown as written.
 */
export const describedText = (d: string | undefined, t: RouteTextSource): string | undefined =>
  d === undefined ? undefined : t.has(d) ? t.dynamic(d, API_TEXT_PARAMS) : d;
/** A JSON Schema with every `description` translated (the docs' schemas, openapi.json). */
export function localizeSchema<T>(js: T, t: RouteTextSource): T {
  if (Array.isArray(js)) return js.map((x) => localizeSchema(x, t)) as T;
  if (!js || typeof js !== "object") return js;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(js as Record<string, unknown>))
    out[k] = k === "description" && typeof v === "string" ? describedText(v, t) : localizeSchema(v, t);
  return out as T;
}
/** Why a route has no command, in the translator's language (undefined: it has one). */
export function exemptText(r: { id: string; cli: Cli }, t: RouteTextSource): string | undefined {
  if (!isExempt(r.cli)) return undefined;
  return typeof r.cli.exempt === "string" ? t.dynamic(r.cli.exempt, API_TEXT_PARAMS) : routeText(r.id, "exempt", t);
}
/** A group's one-line title in the translator's language (`api.group.<id>`). */
export const groupTitle = (id: ApiGroup, t: RouteTextSource) => t.dynamic(`api.group.${id}`);
