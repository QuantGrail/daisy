import type { FastifyInstance } from "fastify";
import { api } from "../../../contracts/src/api/index.ts";
import {
  AutostartError,
  autostartView,
  processHost,
  sayAutostart,
  setAutostart,
  type AutostartHost,
} from "../platform/autostart.ts";
import { HttpError } from "./errors.ts";
import { requestT } from "./language.ts";
import { serve } from "./serve.ts";
import type { AppContext } from "./context.ts";
/**
 * P1-09 (ADR-112 §4): start at boot for the web page's settings — the same
 * logic as `daisy autostart` (packages/daisy/src/platform/autostart.ts), on this
 * process's data directory. Who: the owner (`daisy:manage`, the guard).
 */
export function registerAutostartRoutes(app: FastifyInstance, ctx: AppContext): void {
  const host: AutostartHost = ctx.opts.autostartHost ?? processHost();
  const where = { io: host, dataDir: ctx.opts.dataDir };
  const S = api.settings;
  serve(app, S.autostartStatus, async (req) => autostartView(where, requestT(req, ctx.opts.dataDir)));
  serve(app, S.autostartSet, async (req) => {
    const b = S.autostartSet.body.parse(req.body);
    const t = requestT(req, ctx.opts.dataDir);
    try {
      return await setAutostart(where, b.enabled, t);
    } catch (e) {
      if (e instanceof AutostartError) {
        // Said in the request's language (the error already carries both parts).
        const said = sayAutostart(e.msg, t);
        throw new HttpError(409, t("server-platform.autostart.failed", said), "autostart_failed");
      }
      throw e;
    }
  });
}
