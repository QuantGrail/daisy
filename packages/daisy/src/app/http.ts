import { daisyEnv } from "../../../contracts/src/env.ts";
import websocket from "@fastify/websocket";
import rateLimit from "@fastify/rate-limit";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { conditional } from "./etag.ts";
import { API_VERSION } from "../../../contracts/src/index.ts";
import { HttpError, isLocalized, sayMsg } from "./errors.ts";
import { faceOf, rateIdOf } from "../access/faces.ts";
import { serve } from "./serve.ts";
import { api } from "../../../contracts/src/api/index.ts";
import type { AppContext } from "./context.ts";
import { log } from "../observe/log.ts";
import { redact } from "../observe/redact.ts";
import { languageView, requestT } from "./language.ts";
/**
 * DAISY_ORIGINS (links and framing only — P1-03: never a reason to accept
 * another origin's request), the CSP of HTML pages (P1-00: moved from
 * app.ts).
 */
export function httpHelpers() {
  const allowedOrigins = () =>
    (daisyEnv("DAISY_ORIGINS") || "").split(",").filter(Boolean);
  /**
   * Same-origin embedding means a Daisy XSS is a host XSS (and vice versa),
   * so every HTML page gets a strict policy: no inline or foreign scripts,
   * API/WS to this origin only, framing only by this origin or DAISY_ORIGINS.
   * Inline styles stay allowed (react-native-web and xterm inject <style>).
   */
  const contentSecurityPolicy = () =>
    [
      "default-src 'self'",
      "script-src 'self'",
      "connect-src 'self'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "style-src 'self' 'unsafe-inline'",
      "frame-src 'self'",
      "object-src 'none'",
      `frame-ancestors ${["'self'", ...allowedOrigins().filter((o) => /^https?:\/\/[^\s;,']+$/.test(o))].join(" ")}`,
      "base-uri 'none'",
      "form-action 'self'",
    ].join("; ");
  return { allowedOrigins, contentSecurityPolicy };
}
export type HttpHelpers = ReturnType<typeof httpHelpers>;
/**
 * Rate limits, websockets, the response hooks and the error handler
 * (P1-00: moved from app.ts). P1-03: no CORS — the guard (access/guard.ts,
 * installed first) refuses any other origin's request, so no other origin
 * is ever told it may read an answer.
 */
export async function setupHttp(
  app: FastifyInstance,
  ctx: AppContext,
): Promise<void> {
  const { opts, contentSecurityPolicy } = ctx;
  /**
   * Bucket per caller the guard recognised (a web session, the command
   * line, an AI's turn); otherwise the client address — a refused request
   * never got this far, and the session exchange (public) is limited per
   * address.
   */
  // P5-02 review M-1: per face, and a relay caller by the relay's word (rateIdOf).
  const rateKey = (req: any): string =>
    req.daisyPrincipal
      ? `${faceOf(req)}:${req.daisyPrincipal.label}:${req.daisyPrincipal.webSession ?? ""}`
      : rateIdOf(req);
  await app.register(rateLimit, {
    global: true,
    timeWindow: "1 minute",
    keyGenerator: rateKey,
    max: opts.rateLimit?.user || 6000,
  });
  await app.register(websocket, { options: { maxPayload: 8192 } });
  app.addHook("onSend", async (_req, reply, payload) => {
    reply
      .header("X-Content-Type-Options", "nosniff")
      .header("Referrer-Policy", "no-referrer");
    if (/^text\/html/i.test(String(reply.getHeader("content-type") || "")))
      reply.header("Content-Security-Policy", contentSecurityPolicy());
    // JSON GETs carry an ETag; If-None-Match that matches → 304.
    return conditional(_req, reply, payload);
  });
  app.setErrorHandler((e: any, req, reply) => {
    // P1-05: a locked PIN says how long to wait (local-api.md §4 pin_locked).
    if (typeof e.retryAfter === "number")
      reply.header("Retry-After", String(e.retryAfter));
    // P6-20 (ADR-159): the text in the request's language; the `code` stays.
    const t = requestT(req, ctx.opts.dataDir);
    reply.header("Content-Language", t.lang);
    if (e instanceof z.ZodError)
      return reply.code(400).send({
        error: t("api.error.invalidInput"),
        code: "invalid_input",
        // P6-23a: a route schema's own messages are pack keys (`api.validation.*`).
        details: e.issues.map((x) => redact(t.has(x.message) ? t.dynamic(x.message) : x.message)),
      });
    const localized = isLocalized(e);
    reply.code(e.statusCode || 500).send({
      // S-1: an error answer never carries a credential, token or PIN.
      error: localized
        ? redact(sayMsg(t, e.key, e.params))
        : e.statusCode
          ? redact(String(e.message))
          : t("api.error.serverFault"),
      ...(e instanceof HttpError && e.code ? { code: e.code } : {}),
      ...(!e.statusCode ? { code: "internal" } : {}),
      ...(localized && e.fixKey ? { fix: redact(sayMsg(t, e.fixKey, e.params)) } : {}),
      // A look-alike from a shared package (a2a-client …) may carry its own stable code.
      ...(localized && !(e instanceof HttpError) && typeof e.code === "string" ? { code: e.code } : {}),
      // Modules without HttpError (commands.ts) set `apiCode`.
      ...(typeof e.apiCode === "string" ? { code: e.apiCode } : {}),
      // P1-02: a refused 「立即重启」 names what it would interrupt.
      ...(Array.isArray(e.interrupts) ? { interrupts: e.interrupts } : {}),
      ...(typeof e.confirm === "string" ? { confirm: e.confirm } : {}),
      ...(typeof e.retryAfter === "number" ? { retryAfter: e.retryAfter } : {}),
      // P4-01: what differs (a known contact's newer card), one line each.
      ...(e instanceof HttpError && Array.isArray((e as any).details)
        ? { details: (e as any).details.map((x: unknown) => redact(String(x))) }
        : {}),
      // P4-11: what to do instead (`capability_unsupported`); the command
      // line prints it as 怎么办.
      ...(e.statusCode && typeof e.fix === "string" ? { fix: redact(e.fix) } : {}),
    });
    if (!e.statusCode) log.error("Server error:", e.message);
  });
}
/** GET /api/health, public (P1-00: moved from app.ts). */
export function registerHealthRoute(
  app: FastifyInstance,
  ctx: AppContext,
): void {
  const { lifecycle, branding, allowedOrigins } = ctx;
  serve(app, api.system.health, async () => ({
    ok: true,
    apiVersion: API_VERSION,
    // The commit this process runs (`.release`).
    release: lifecycle.release,
    now: Date.now(),
    // What this control plane serves (session.context / quota,
    // identity auto-compact settings); absent on older ones.
    features: { contextUsage: 1 },
    // P6-20: the owner's language (no secret; the sign-in page shows it before a session).
    language: languageView(ctx.opts.dataDir).effective,
    ...(branding ? { branding } : {}),
    // DAISY_ORIGINS (already public in the CSP frame-ancestors header): the
    // other origins a host link (task.url, branding hostUrl) may lead to.
    hostOrigins: allowedOrigins().filter((o) =>
      /^https?:\/\/[^\s/;,']+$/.test(o),
    ),
  }));
}
