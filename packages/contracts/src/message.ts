import { z } from "zod";
import { defaultTranslate } from "./i18n-default.ts";
// Sending a message: host page context, terminal runs (P1-00: moved from index.ts).
/**
 * One command the user ran from the composer's 「在终端执行」 mode:
 * executed by their own runner as their own OS account, in the session's
 * workspace, then attached to their next message so the Agent sees it.
 */
export interface TerminalResult {
  id: string;
  command: string;
  cwd: string;
  /** null when killed (timeout) or it never started. */
  exitCode: number | null;
  timedOut: boolean;
  /** stdout + stderr interleaved, ANSI stripped, head + tail when too long. */
  output: string;
  truncated: boolean;
  durationMs: number;
  error?: string;
}
export const ShellRunSchema = z.object({
  command: z
    .string()
    .max(4000)
    .refine((x) => x.trim().length > 0, { error: () => defaultTranslate()("server-contracts.message.commandEmpty") }),
});
/**
 * Per-message host context (DESIGN fb3 F1): what the host page the user is
 * on shows, sent with one user message and prepended to it as
 * `<host_page_context>` (user-provided data, never system instructions).
 */
export const MessageContextSchema = z.object({
  /** Host de-duplication key (page + focus); same key = same context. */
  key: z.string().min(1).max(300),
  /** One display line, e.g. 「任务 T-1 · 标题」. */
  label: z.string().min(1).max(200),
  /** Body sent to the Agent (plain text / Markdown). */
  text: z.string().min(1).max(20000),
  /** Page address, for display only (the host validates it). */
  url: z.string().max(2000).optional(),
  /** Host objects the page is about; task refs accumulate in session.relatedTasks. */
  refs: z
    .array(
      z.object({
        kind: z.literal("task"),
        id: z.string().min(1).max(200),
        title: z.string().max(500).default(""),
        url: z.string().max(2000).optional(),
      }),
    )
    .max(20)
    .default([]),
});
export type MessageContext = z.infer<typeof MessageContextSchema>;
/** What a caller may pass (`refs` and ref `title` default when omitted). */
export type MessageContextInput = z.input<typeof MessageContextSchema>;
/** Cut to `max` UTF-16 units with a trailing 「…」, never splitting a surrogate pair. */
function clip(value: string, max: number) {
  if (value.length <= max) return value;
  let out = value.slice(0, max - 1);
  if (/[\uD800-\uDBFF]$/.test(out)) out = out.slice(0, -1);
  return out + "…";
}
/** FNV-1a 32-bit, hex: a short stable digest for over-long context keys. */
function shortHash(value: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
/**
 * Make a host context fit MessageContextSchema instead of failing the send
 * (fb3 review G1): label / text / ref titles are cut with 「…」, an
 * over-long key becomes its first 290 characters + `#` + a stable hash (so
 * the same page still de-duplicates), over-long URLs are dropped (a cut URL
 * would point elsewhere), refs beyond 20 or with an unusable id are dropped.
 * `trimmed` says something was changed; `context: null` (with `invalid`)
 * when even that cannot produce a valid context (e.g. empty label or text).
 */
export function fitMessageContext(
  raw: MessageContextInput | null | undefined,
): {
  context: MessageContext | null;
  trimmed: boolean;
  invalid: boolean;
} {
  if (!raw) return { context: null, trimmed: false, invalid: false };
  const exact = MessageContextSchema.safeParse(raw);
  if (exact.success)
    return { context: exact.data, trimmed: false, invalid: false };
  let trimmed = false;
  const str = (v: unknown, max: number) => {
    if (typeof v !== "string" || v.length <= max) return v;
    trimmed = true;
    return clip(v, max);
  };
  const url = (v: unknown) => {
    if (typeof v === "string" && v.length > 2000) {
      trimmed = true;
      return undefined;
    }
    return v;
  };
  const r: any = raw;
  let key = r.key;
  if (typeof key === "string" && key.length > 300) {
    trimmed = true;
    key = key.slice(0, 290) + "#" + shortHash(key);
  }
  const refs = Array.isArray(r.refs)
    ? r.refs
        .filter((x: any) => {
          const ok =
            x &&
            x.kind === "task" &&
            typeof x.id === "string" &&
            x.id.length >= 1 &&
            x.id.length <= 200;
          if (!ok) trimmed = true;
          return ok;
        })
        .slice(0, 20)
        .map((x: any) => {
          const u = url(x.url);
          return {
            kind: "task",
            id: x.id,
            title: str(x.title ?? "", 500),
            ...(u !== undefined ? { url: u } : {}),
          };
        })
    : r.refs;
  if (Array.isArray(r.refs) && r.refs.length > 20) trimmed = true;
  const u = url(r.url);
  const fitted = MessageContextSchema.safeParse({
    key,
    label: str(r.label, 200),
    text: str(r.text, 20000),
    ...(u !== undefined ? { url: u } : {}),
    refs,
  });
  return fitted.success
    ? { context: fitted.data, trimmed, invalid: false }
    : { context: null, trimmed: false, invalid: true };
}
export const SendSchema = z
  .object({
    requestId: z.string().min(8).max(100),
    delivery: z.enum(["normal", "queue"]).default("normal"),
    text: z.string().max(100000),
    attachmentIds: z.array(z.string()).max(8).default([]),
    /** Host page context for this message (fb3 F1). */
    context: MessageContextSchema.optional(),
    /** Finished terminal runs to send with this message. */
    terminalIds: z.array(z.string().max(100)).max(8).default([]),
  })
  .refine(
    (x) => x.text.trim() || x.attachmentIds.length || x.terminalIds.length,
    { error: () => defaultTranslate()("server-contracts.message.empty") },
  );
