import { hash } from "node:crypto";

/**
 * Conditional GETs. A successful JSON GET under /api gets a weak
 * ETag computed from the serialized body; a request whose If-None-Match
 * lists that tag gets 304 with no body. The tag only says "the bytes you
 * hold are what I would send" — it is derived from the body alone, so two
 * people get the same tag only for byte-identical bodies (nothing leaks:
 * a 304 confirms the copy the caller already has). Responses that choose
 * their own caching (an ETag of their own, `no-store`) are left alone.
 *
 * `Cache-Control: private, no-store`: the client (DaisyClient) keeps the
 * body itself; no HTTP cache may. With `no-cache` iOS URLSession (expo/fetch,
 * the App's global fetch) stored the 200 and turned every 304 back into a
 * 200 with the full cached body, so the App never saw a 304 and parsed the
 * whole list on every read. The read stays as fresh as before; the
 * transfer and the client's parse are saved.
 */
export function etagFor(body: string): string {
  return 'W/"' + hash("sha1", body, "base64url").slice(0, 22) + '"';
}

/** Whether an If-None-Match header value matches `tag` (weak comparison). */
export function ifNoneMatch(header: unknown, tag: string): boolean {
  if (typeof header !== "string" || !header) return false;
  if (header.trim() === "*") return true;
  const bare = (t: string) => t.trim().replace(/^W\//, "");
  const want = bare(tag);
  return header.split(",").some((t) => bare(t) === want);
}

/** Bodies above this are sent as they are (hashing would cost more than it saves). */
export const ETAG_MAX_BYTES = 8 * 1024 * 1024;

/**
 * The onSend step: returns the payload to send (empty for a 304). Only
 * GET (and HEAD) 200s with a string JSON payload under /api take part.
 */
export function conditional(req: any, reply: any, payload: unknown): unknown {
  if (req.method !== "GET" && req.method !== "HEAD") return payload;
  if (reply.statusCode !== 200 || typeof payload !== "string") return payload;
  if (payload.length > ETAG_MAX_BYTES) return payload;
  if (!String(req.url).startsWith("/api/")) return payload;
  if (
    !/^application\/json/i.test(String(reply.getHeader("content-type") || ""))
  )
    return payload;
  if (reply.getHeader("etag")) return payload;
  const cc = String(reply.getHeader("cache-control") || "");
  if (/no-store/i.test(cc)) return payload;
  const tag = etagFor(payload);
  reply.header("ETag", tag);
  if (!cc) reply.header("Cache-Control", "private, no-store");
  if (!ifNoneMatch(req.headers["if-none-match"], tag)) return payload;
  reply.code(304);
  reply.removeHeader("content-type");
  reply.removeHeader("content-length");
  return "";
}
