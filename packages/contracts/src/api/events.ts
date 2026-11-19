/**
 * P2-03 (5.10 「事件出口」, docs/contracts/events.md §3–§5): reading the
 * event outlet — by sequence number, with a long poll, and a snapshot to
 * start from. `daisy:events:read` (scopes.md, README 待决点 2 → B): the
 * owner's web page, paired devices and command line have it; an outside
 * token may carry only it (and then reads no conversation). An AI's
 * working credential cannot read it. packages/daisy/src/sessions/event-outlet.ts.
 */
import { z } from "zod";
import { cmd, group, json, route } from "./route.ts";
import { EVENT_LIMITS } from "../limits.ts";
import type { EventsPage, EventsSnapshot } from "../events.ts";

export const EventsQuerySchema = z.object({
  after: z.coerce
    .number()
    .int()
    .min(0)
    .optional()
    .describe("api.field.events.after"),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(EVENT_LIMITS.pageMax)
    .optional()
    .describe("api.field.events.limit"),
  wait: z.coerce
    .number()
    .int()
    .min(0)
    .max(EVENT_LIMITS.waitMaxS)
    .optional()
    .describe("api.field.events.wait"),
});

export const events = group("events", {
  list: route({
    method: "GET",
    path: "/api/events",
    scope: "daisy:events:read",
    query: EventsQuerySchema,
    output: json<EventsPage>("EventsPage { events: DaisyEvent[], cursor, hasMore }"),
    errors: ["cursor_reset"],
    cli: cmd("events list"),
  }),
  snapshot: route({
    method: "GET",
    path: "/api/events/snapshot",
    scope: "daisy:events:read",
    output: json<EventsSnapshot>("EventsSnapshot { events: DaisyEvent[], cursor, snapshot: true }"),
    cli: cmd("events snapshot"),
  }),
});
