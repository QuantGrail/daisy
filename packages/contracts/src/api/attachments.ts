/** P1-06: attachments (packages/daisy/src/app/attachments.ts). */
import { z } from "zod";
import { binary, cmd, fileInput, group, json, route } from "./route.ts";
import type { Attachment } from "../items.ts";

export const attachments = group("attachment", {
  upload: route({
    method: "POST",
    path: "/api/attachments",
    scope: "daisy:session:write",
    body: z.object({
      name: z.string().min(1).max(250).describe("api.route.attachment.upload.field.name"),
      mime: z.string().max(150).describe("api.route.attachment.upload.field.mime"),
      data: fileInput(
        z
          .string()
          .max(12 * 1024 * 1024)
          .describe("api.route.attachment.upload.field.data"),
      ),
    }),
    output: json<Attachment>("Attachment"),
    errors: ["attachment_encoding", "attachment_too_large"],
    cli: cmd("attachment upload"),
  }),
  download: route({
    method: "GET",
    path: "/api/attachments/:id",
    scope: "daisy:session:read",
    output: binary("api.output.attachmentBytes"),
    errors: ["attachment_not_found"],
    cli: cmd("attachment download"),
  }),
});
