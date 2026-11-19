/**
 * P1-06: what the docs and the command line read of a zod schema — its
 * JSON Schema (zod 4's own `z.toJSONSchema`) and, for an object, its
 * top-level fields.
 */
import { z } from "zod";

export type JsonSchema = Record<string, any>;

/** The schema as a client sends it (input side), never throwing. */
export function inputJsonSchema(schema: z.ZodType): JsonSchema {
  const js = z.toJSONSchema(schema, {
    io: "input",
    unrepresentable: "any",
    target: "draft-2020-12",
  }) as JsonSchema;
  delete js.$schema;
  return js;
}

/**
 * One limit of a field: a length (characters), a value, a number of items
 * — each a range — or its default. Text only when shown (`limitsText`), in
 * the reader's language.
 */
export type FieldLimit =
  | { kind: "length" | "value" | "items"; min?: number; max?: number }
  | { kind: "default"; value: unknown };

/** What `limitsText` needs of a translator (`Translate` fits). */
interface LimitTextSource {
  dynamic(key: string, params?: Record<string, unknown>): string;
}

/** A field's limits as text, in the translator's language (`1–200 characters, default 0`). */
export function limitsText(limits: readonly FieldLimit[], t: LimitTextSource): string {
  return limits
    .map((l) => {
      if (l.kind === "default") return t.dynamic("api.limit.default", { value: JSON.stringify(l.value) });
      const range =
        l.min !== undefined && l.max !== undefined
          ? `${l.min}–${l.max}`
          : l.min !== undefined
            ? `≥ ${l.min}`
            : `≤ ${l.max}`;
      return l.kind === "value" ? range : t.dynamic(`api.limit.${l.kind}`, { range });
    })
    .join(t.dynamic("api.limit.separator"));
}

export interface FieldInfo {
  name: string;
  required: boolean;
  /** Short type text: `string`, `integer`, `"a" | "b"`, `string[]`, `object`… */
  type: string;
  /** Limits and default (shown with `limitsText`: `1–200 characters`, `default 0`). */
  limits: FieldLimit[];
  description?: string;
  enum?: readonly (string | number | boolean | null)[];
  default?: unknown;
  /** `secret` / `file` (route.ts `secretInput` / `fileInput`). */
  input?: "secret" | "file";
}

/** One line of type text for a JSON Schema node. */
export function typeText(js: JsonSchema | undefined): string {
  if (!js || Object.keys(js).length === 0) return "any";
  if (js.const !== undefined) return JSON.stringify(js.const);
  if (Array.isArray(js.enum)) return js.enum.map((v: unknown) => JSON.stringify(v)).join(" | ");
  const alts = js.anyOf || js.oneOf;
  if (Array.isArray(alts))
    return [...new Set(alts.map((a: JsonSchema) => typeText(a)))].join(" | ");
  if (js.type === "array") return `${typeText(js.items)}[]`;
  if (Array.isArray(js.type)) return js.type.join(" | ");
  if (js.type === "object" && js.additionalProperties && !js.properties)
    return `Record<string, ${typeText(js.additionalProperties)}>`;
  return js.type || "any";
}

function limitsOf(js: JsonSchema): FieldLimit[] {
  const out: FieldLimit[] = [];
  // `.int()` adds ±MAX_SAFE_INTEGER: no limit worth printing.
  const big = (v: unknown) =>
    typeof v === "number" && Math.abs(v) >= Number.MAX_SAFE_INTEGER;
  const range = (lo: unknown, hi: unknown, kind: "length" | "value" | "items") => {
    if (big(lo)) lo = undefined;
    if (big(hi)) hi = undefined;
    if (lo !== undefined || hi !== undefined)
      out.push({ kind, ...(lo !== undefined ? { min: lo as number } : {}), ...(hi !== undefined ? { max: hi as number } : {}) });
  };
  range(js.minLength, js.maxLength, "length");
  range(js.minimum ?? js.exclusiveMinimum, js.maximum ?? js.exclusiveMaximum, "value");
  range(js.minItems, js.maxItems, "items");
  if (js.default !== undefined) out.push({ kind: "default", value: js.default });
  return out;
}

const isObject = (js: JsonSchema) => js.type === "object" && !!js.properties;

function fieldsOf(js: JsonSchema): FieldInfo[] {
  const required = new Set<string>(js.required || []);
  return Object.entries(js.properties as Record<string, JsonSchema>).map(
    ([name, p]) => ({
      name,
      // An input field with a default may be left out.
      required: required.has(name) && p.default === undefined,
      type: typeText(p),
      limits: limitsOf(p),
      ...(p.description ? { description: p.description as string } : {}),
      ...(Array.isArray(p.enum) ? { enum: p.enum } : {}),
      ...(p.default !== undefined ? { default: p.default } : {}),
      ...(p["x-daisy-input"] === "secret" || p["x-daisy-input"] === "file"
        ? { input: p["x-daisy-input"] as "secret" | "file" }
        : {}),
    }),
  );
}

/**
 * Top-level fields of an object schema — or of a union of objects (a
 * discriminated union: one field list, a field required only when every
 * variant requires it, its types joined). null when it is neither.
 */
export function objectFields(schema: z.ZodType | undefined): FieldInfo[] | null {
  if (!schema) return [];
  const js = inputJsonSchema(schema);
  if (isObject(js)) return fieldsOf(js);
  const alts: JsonSchema[] | undefined = js.anyOf || js.oneOf;
  if (!alts?.length || !alts.every(isObject)) return null;
  const merged = new Map<string, FieldInfo>();
  const variants = alts.map(fieldsOf);
  for (const fields of variants)
    for (const f of fields) {
      const had = merged.get(f.name);
      if (!had) {
        merged.set(f.name, { ...f });
        continue;
      }
      const types = new Set([...had.type.split(" | "), ...f.type.split(" | ")]);
      had.type = [...types].join(" | ");
      if (JSON.stringify(had.limits) !== JSON.stringify(f.limits)) had.limits = [];
      had.required &&= f.required;
      had.description ??= f.description;
    }
  for (const f of merged.values())
    if (!variants.every((v) => v.some((x) => x.name === f.name)))
      f.required = false;
  return [...merged.values()];
}
