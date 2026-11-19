import type { FastifyInstance } from "fastify";
import {
  RestartRefused,
  describeBusy,
  droppedReason,
  type BusyItem,
} from "../update/restart.ts";
import { join } from "node:path";
import { HttpError, LocalizedError } from "./errors.ts";
import type { Translate } from "../../../contracts/src/i18n.ts";
import { requestT } from "./language.ts";
import { commitLetIn } from "../access/let-in-commit.ts";
import { serve } from "./serve.ts";
import { api } from "../../../contracts/src/api/index.ts";
import type { AppContext } from "./context.ts";
import { UpdateRefused, validSource, writeSourceSetting, type PackageStatus } from "../update/package.ts";
import { readRunnerJson } from "../platform/settings.ts";
/**
 * P1-02: restart / update of this whole process, for its owner (was
 * the 「重启」 per execution node, /api/nodes/:id/restart).
 *
 * - `GET /api/update`: what is pending (an installed or a built release
 *   waiting for idleness, the owner's request) and what it waits for — the
 *   conversations with a running turn, online AIs with work in hand,
 *   background commands, sign-ins, terminal commands.
 * - `POST /api/update/restart {mode}`: `idle` restarts once nothing runs;
 *   `now` interrupts what runs — refused (409) with the list of what it
 *   would interrupt and a `confirm` token for exactly that list, unless
 *   `confirm` is the token of a list covering everything running now (a
 *   turn started since → 409 again, new list, new token); while a `now`
 *   waits nothing new is claimed. Interrupted turns end as 「中断」
 *   with a notice; nothing is replayed.
 * - `DELETE /api/update/restart`: withdraw a request not carried out yet
 *   (and a P5-06 apply not carried out yet).
 * - P5-06 (ADR-145), an npm-installed Daisy: `POST /api/update/check`
 *   looks at the update source now; `POST /api/update/apply {from?,
 *   allowDowngrade?}` switches to the newest (or the given package) once
 *   idle — backed up, installed, confirmed or rolled back
 *   (update/package.ts, update/guard.ts).
 *
 * Who: the owner (P1-03: the guard checks `daisy:manage`). Each request
 * is audited, with what a `now` interrupted.
 */
export function registerUpdateRoutes(
  app: FastifyInstance,
  ctx: AppContext,
): void {
  const { store, restart, lifecycle } = ctx;
  /** Busy items as the asking user may see them (others' titles hidden). */
  const view = (uid: string, busy: BusyItem[], t: Translate) =>
    busy.map((b) => {
      const s = b.sessionId ? store.session(b.sessionId) : null;
      return {
        ...b,
        ...(s
          ? {
              session:
                s.ownerId === uid
                  ? { id: s.id, title: s.title, agent: s.agent }
                  : { id: s.id, title: t("server-update.otherMembersSession") },
            }
          : {}),
      };
    });
  const U = api.settings;
  serve(app, U.updateStatus, async (req) => {
    const u = ctx.user(req);
    const t = requestT(req, ctx.opts.dataDir);
    const st = restart.status();
    const sup = st.supervision;
    return {
      release: lifecycle.release,
      runner: st.runner,
      supervised: st.supervision?.supervised ?? false,
      ...(st.supervision ? { manager: st.supervision.manager } : {}),
      ...(sup?.reasonKey ? { reason: t.dynamic(sup.reasonKey) } : sup?.reason ? { reason: sup.reason } : {}),
      update: st.update,
      request: st.request,
      idle: st.idle,
      waitingFor: view(u.id, st.busy, t),
      summary: describeBusy(st.busy, t),
      // P5-06: the npm package's side (source, what was found, the last outcome).
      ...(ctx.packageUpdate ? { package: ctx.packageUpdate.status() } : {}),
      // A confirmed 立即重启 dropped because work started after the
      // confirmation: when, why, and what (until the next request).
      ...(st.lastCancelled
        ? {
            lastCancelled: {
              at: st.lastCancelled.at,
              reason: droppedReason(st.lastCancelled.extra, t),
              mode: st.lastCancelled.request.mode,
              extra: view(u.id, st.lastCancelled.extra, t),
            },
          }
        : {}),
    };
  });
  serve(app, U.updateRestart, async (req) => {
    const u = ctx.user(req),
      b = U.updateRestart.body.parse(req.body ?? {});
    const t = requestT(req, ctx.opts.dataDir);
    try {
      const busy = restart.busy();
      const r = restart.request(b.mode, { confirm: b.confirm, by: u.id });
      store.audit(
        u.id,
        `process.restart.${b.mode}`,
        b.mode === "now" && busy.length
          ? `interrupts:${busy
              .map((x) => `${x.kind}:${x.sessionId ?? x.id ?? "?"}`)
              .join(",")
              .slice(0, 900)}`
          : "-",
      );
      return {
        request: r,
        ...(b.mode === "now" ? { interrupts: view(u.id, busy, t) } : {}),
        waitingFor: b.mode === "idle" ? view(u.id, busy, t) : [],
      };
    } catch (e) {
      if (!(e instanceof RestartRefused)) throw e;
      if (e.interrupts) {
        const err = new HttpError(409, e.say(t), "restart_interrupts") as any;
        err.interrupts = view(u.id, e.interrupts, t);
        err.confirm = e.confirm;
        throw err;
      }
      throw new HttpError(409, e.say(t), "restart_unavailable");
    }
  });
  /** P5-06: the npm-package updater, or why there is none. */
  const pkg = () => {
    const p = ctx.packageUpdate;
    if (!p)
      throw new LocalizedError(409, "update_unavailable", "server-update.notPackaged");
    return p;
  };
  const refused = (e: unknown, req: unknown): never => {
    if (e instanceof UpdateRefused) throw new HttpError(409, e.say(requestT(req)), "update_unavailable");
    throw e;
  };
  serve(app, U.updateCheck, async (req) => {
    const u = ctx.user(req);
    let st: PackageStatus;
    try {
      st = await pkg().check();
    } catch (e) {
      return refused(e, req);
    }
    store.audit(u.id, "update.check", st.available ? `available:${st.available.release ?? st.available.version}` : "-");
    return { package: st };
  });
  serve(app, U.updateApply, async (req) => {
    const u = ctx.user(req),
      b = U.updateApply.body.parse(req.body ?? {});
    let st: PackageStatus;
    try {
      st = await pkg().apply({ from: b.from, allowDowngrade: b.allowDowngrade });
    } catch (e) {
      return refused(e, req);
    }
    store.audit(
      u.id,
      "update.request",
      JSON.stringify({ to: st.available?.release ?? st.available?.version, from: b.from ? "file" : "source", downgrade: !!b.allowDowngrade }),
    );
    return { package: st, waitingFor: view(u.id, restart.busy(), requestT(req, ctx.opts.dataDir)) };
  });
  serve(app, U.updateSourceSet, async (req) => {
    const u = ctx.user(req),
      b = U.updateSourceSet.body.parse(req.body ?? {});
    const p = pkg();
    let value: string | null = null;
    if (b.source !== null)
      try {
        value = validSource(b.source);
      } catch (e) {
        throw new HttpError(400, e instanceof UpdateRefused ? e.say(requestT(req, ctx.opts.dataDir)) : (e as Error).message, "invalid_source");
      }
    // A PIN route persists only under the PIN its grant passed with (ADR-121 §4a).
    commitLetIn(req, () => {
      // P6-16 (ADR-160; review L6): read, judged and written in one step.
      // Rewriting a runner.json others can write (or another account's)
      // would make everything in it — plugins too — the owner's; one that is
      // not JSON would be replaced by only { updateSource }, losing the node.
      const file = join(ctx.opts.dataDir, "runner.json");
      const current = readRunnerJson(ctx.opts.dataDir);
      if (current.distrust)
        throw new LocalizedError(409, "runner_json_untrusted", "api.error.runnerJsonUntrusted", { file, why: current.distrust });
      if (current.broken) throw new LocalizedError(409, "runner_json_broken", "api.error.runnerJsonBroken", { why: current.broken });
      writeSourceSetting(ctx.opts.dataDir, value, current.config ?? {});
      p.setSource(value);
      store.audit(u.id, "update.source", JSON.stringify({ source: value }));
    });
    return { package: p.status() };
  });
  serve(app, U.updateCancel, async (req) => {
    const u = ctx.user(req);
    const withdrawn = ctx.packageUpdate?.withdraw() ?? false;
    const had = restart.cancel() || withdrawn;
    if (had) store.audit(u.id, "process.restart.cancel", "-");
    return { ok: true, cancelled: had };
  });
}
