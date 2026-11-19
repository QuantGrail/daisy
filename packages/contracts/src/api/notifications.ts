/**
 * P1-08: reading the session notifications (P1-01 kept only the writer —
 * packages/daisy/src/sessions/notifications.ts). The local web page shows what a
 * session raised: a turn ended, an approval card, an AI that failed. The
 * event outlet (P2-03) reads the same outbox in its own way.
 */
import { z } from "zod";
import { cmd, group, json, route } from "./route.ts";
import {
  NOTIFICATION_DEVICES,
  type NotificationItem,
} from "../notifications.ts";

export const NotificationsQuerySchema = z.object({
  sessionId: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe("api.field.notifications.sessionId"),
  after: z.coerce
    .number()
    .int()
    .min(0)
    .optional()
    .describe("api.field.notifications.after"),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe("api.field.notifications.limit"),
  device: z
    .enum(NOTIFICATION_DEVICES)
    .optional()
    .describe("api.field.notifications.device"),
});

export interface NotificationsPage {
  /** Each item's current state (its latest revision), newest change first. */
  items: NotificationItem[];
  /** The newest outbox sequence seen; pass it back as `after`. */
  cursor: number;
}

export const notifications = group("session", {
  notifications: route({
    method: "GET",
    path: "/api/notifications",
    scope: "daisy:session:read",
    query: NotificationsQuerySchema,
    output: json<NotificationsPage>("{ items: NotificationItem[], cursor }"),
    cli: cmd("notify list"),
  }),
});
