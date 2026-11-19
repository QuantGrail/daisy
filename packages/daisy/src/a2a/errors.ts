/**
 * P4-04 (a2a-usage.md §9.1, ADR-123): a request the A2A entry refuses
 * without making a task — the same refusal in both transports' shapes:
 * HTTP+JSON a `google.rpc.Status` (`{ error: { code, status, message,
 * details } }`), JSON-RPC an `error` object (`{ code, message, data }`),
 * each with a `google.rpc.ErrorInfo` (and a `google.rpc.BadRequest` for a
 * field). Messages say what happened and what to do (3.7), never a token.
 */
import {
  A2A_ERRORS,
  RPC_STATUS,
  type A2AErrorReason,
} from "../../../contracts/src/a2a.ts";
import { languagesOf, parseAcceptLanguage, translator, type Translate } from "../../../contracts/src/i18n.ts";
import { packsFor } from "../../../contracts/src/i18n-node.ts";
import { englishText, type Msg } from "../app/errors.ts";
import { ownerT } from "../platform/language.ts";

/**
 * P6-23b (ADR-159): a refusal's text is a message key, said when the
 * answer is written — in the caller's language (`Accept-Language`), else
 * the owner's. A plain string is text already said (another side's words,
 * a validator's own message) and goes out as it is.
 */
export type A2AText = Msg | string;

/** The translator for a request: its `Accept-Language`, else the owner's language. */
export function callerT(req: { headers?: Record<string, unknown> } | undefined): Translate {
  const owner = ownerT();
  const header = req?.headers?.["accept-language"];
  if (typeof header !== "string") return owner;
  const packs = packsFor(undefined);
  const asked = parseAcceptLanguage(header, languagesOf(packs));
  return asked && asked !== owner.lang ? translator(packs, asked) : owner;
}

/** A text in `t`'s language. */
export const sayText = (x: A2AText, t: Translate = ownerT()): string =>
  typeof x === "string" ? x : t.dynamic(x.key, x.params);

export interface FieldViolation {
  field: string;
  description: A2AText;
}

export class A2AError extends Error {
  constructor(
    readonly reason: A2AErrorReason,
    /** What to say (`message` is it in English, for logs). */
    readonly text: A2AText,
    readonly more: { fields?: FieldViolation[]; metadata?: Record<string, string>; retryAfterS?: number } = {},
  ) {
    super(typeof text === "string" ? text : englishText(text.key, text.params));
  }
  /** The message in `t`'s language. */
  say(t?: Translate): string {
    return sayText(this.text, t);
  }
  get http(): number {
    return A2A_ERRORS[this.reason].http;
  }
  get rpc(): number {
    return A2A_ERRORS[this.reason].rpc;
  }
}

const ERROR_INFO = "type.googleapis.com/google.rpc.ErrorInfo";
const BAD_REQUEST = "type.googleapis.com/google.rpc.BadRequest";

function details(e: A2AError, t?: Translate): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [
    {
      "@type": ERROR_INFO,
      reason: e.reason,
      domain: A2A_ERRORS[e.reason].domain,
      ...(e.more.metadata ? { metadata: e.more.metadata } : {}),
    },
  ];
  if (e.more.fields?.length)
    out.push({
      "@type": BAD_REQUEST,
      fieldViolations: e.more.fields.map((f) => ({ field: f.field, description: sayText(f.description, t) })),
    });
  return out;
}

/** HTTP+JSON: `google.rpc.Status` (`t`: the caller's language, `callerT`). */
export const statusBody = (e: A2AError, t?: Translate) => ({
  error: {
    code: e.http,
    status: RPC_STATUS[e.http] ?? "UNKNOWN",
    message: e.say(t),
    details: details(e, t),
  },
});

/** JSON-RPC: the whole response with `error`. */
export const rpcErrorBody = (id: unknown, e: A2AError, t?: Translate) => ({
  jsonrpc: "2.0",
  id: id ?? null,
  error: { code: e.rpc, message: e.say(t), data: details(e, t) },
});

/** The guard's refusal (401 / 403) as an A2A error; its own `code` in the metadata. */
export function guardRefusal(status: number, code: string, message: A2AText): A2AError {
  const reason: A2AErrorReason = status === 401 ? "UNAUTHENTICATED" : status === 404 ? "NOT_FOUND" : "PERMISSION_DENIED";
  return new A2AError(reason, message, { metadata: { code } });
}

/** A zod error → INVALID_ARGUMENT with the fields named (`prefix` e.g. `message`). */
export function invalidArgument(issues: readonly { path: readonly PropertyKey[]; message: string }[], prefix = ""): A2AError {
  const fields = issues.slice(0, 20).map((i) => ({
    field: [prefix, ...i.path.map(String)].filter(Boolean).join("."),
    description: i.message,
  }));
  const first = fields[0];
  // The field's own description is the validator's (as it is); "request body" is ours.
  const t = ownerT();
  return new A2AError(
    "INVALID_ARGUMENT",
    {
      key: "server-a2a.invalidArgument",
      params: {
        first: first
          ? t("server-a2a.invalidArgument.first", { field: first.field || t("server-a2a.invalidArgument.body"), description: first.description })
          : "",
      },
    },
    { fields },
  );
}
