/**
 * P1-06: system — health (packages/daisy/src/app/http.ts), the live
 * socket (app/events.ts). P6-01 (ADR-151): the mobile client build
 * routes went with the Expo native app.
 */
import { z } from "zod";
import { cmd, exempt, group, json, route, websocket } from "./route.ts";
import type { HostBranding } from "../branding.ts";
import type { Me } from "../user.ts";

export const system = group("system", {
  me: route({
    method: "GET",
    path: "/api/me",
    scope: "daisy:session:read",
    output: json<Me>("Me"),
    cli: cmd("whoami"),
  }),
  health: route({
    method: "GET",
    path: "/api/health",
    scope: null,
    output: json<{
      ok: boolean;
      apiVersion: number;
      release: string | null;
      now: number;
      features: Record<string, number>;
      branding?: HostBranding;
      hostOrigins: string[];
      language?: string;
    }>("{ ok, apiVersion, release, now, features, branding?, hostOrigins, language? }"),
    cli: exempt(),
  }),
  live: route({
    method: "GET",
    path: "/api/live",
    scope: "daisy:session:read",
    auth: "socket-first-frame",
    output: websocket("api.output.liveFrames"),
    cli: exempt(),
  }),
  // P6-20 (ADR-159 §4): the web UI's language pack. Public: the sign-in
  // page needs it before there is a session; it holds only interface text.
  locales: route({
    method: "GET",
    path: "/api/locales/:lang",
    scope: null,
    params: z.object({ lang: z.string().describe("api.route.system.locales.field.lang") }),
    query: z
      .object({
        areas: z.string().max(200).optional().describe("api.route.system.locales.field.areas"),
      })
      .strict(),
    output: json<{ lang: string; fallback: string; messages: Record<string, string> }>("{ lang, fallback, messages }"),
    errors: ["language_unknown"],
    cli: exempt(),
  }),
});
