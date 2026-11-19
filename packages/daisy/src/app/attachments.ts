import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { id } from "../store/index.ts";
import { LocalizedError } from "./errors.ts";
import { serve } from "./serve.ts";
import { api } from "../../../contracts/src/api/index.ts";
import type { AppContext } from "./context.ts";
/** Upload and download an attachment (P1-00: moved from app.ts). */
export function registerAttachmentRoutes(
  app: FastifyInstance,
  ctx: AppContext,
): void {
  const { opts, store, user } = ctx;
  const A = api.attachments;
  serve(app, A.upload, async (req) => {
    const u = user(req),
      b = A.upload.body.parse(req.body);
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b.data))
      throw new LocalizedError(400, "attachment_encoding", "server-app.attachment.encoding");
    const bytes = Buffer.from(b.data, "base64");
    if (bytes.length > 8 * 1024 * 1024)
      throw new LocalizedError(413, "attachment_too_large", "server-app.attachment.tooLarge", { max: "8 MiB" });
    const aid = id(),
      dir = join(opts.dataDir, "attachments");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const p = join(dir, aid);
    writeFileSync(p, bytes, { mode: 0o600 });
    store.run(
      "INSERT INTO attachments VALUES(?,?,?,?,?,?)",
      aid,
      u.id,
      b.name,
      b.mime,
      bytes.length,
      p,
    );
    return { id: aid, name: b.name, mime: b.mime, size: bytes.length };
  });
  serve(app, A.download, async (req, reply) => {
    const u = user(req),
      a = store.one(
        "SELECT * FROM attachments WHERE id=? AND owner_id=?",
        (req.params as any).id,
        u.id,
      );
    if (!a) throw new LocalizedError(404, "attachment_not_found", "server-app.attachment.notFound");
    const inline = /^image\/(png|jpeg|gif|webp)$/.test(a.mime);
    reply
      .type(inline ? a.mime : "application/octet-stream")
      .header(
        "Content-Disposition",
        `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(a.name)}`,
      )
      .header("Cache-Control", "private, no-store");
    return readFileSync(a.path);
  });
}
