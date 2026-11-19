/**
 * P1-07 (ADR-107 §3): the routes the local commands call, by their ids in
 * the definition table — never a second spelling of a path. A route this
 * build's table does not have (the PIN's, before P1-05 is merged) is
 * answered like Daisy answers an unknown route.
 */
import { API_ROUTES, fillPath, type AnyRoute } from "../../../contracts/src/index.ts";
import { CliError } from "./errors.ts";
import { t } from "./lang.ts";
import type { CallOptions, Daisy, Reply } from "./daisy.ts";

export const ROUTES = {
  health: "system.health",
  openCode: "settings.openCode",
  openCodeExternal: "settings.openCodeExternal",
  access: "settings.show",
  relay: "settings.relayShow",
  updateStatus: "settings.updateStatus",
  updateRestart: "settings.updateRestart",
  updateCancel: "settings.updateCancel",
  updateCheck: "settings.updateCheck",
  updateApply: "settings.updateApply",
  updateSourceSet: "settings.updateSourceSet",
  catalog: "workspace.catalog",
  pinStatus: "settings.pinStatus",
  pinGrant: "settings.pinGrant",
} as const;

/**
 * The PIN's two routes as local-api.md §6 fixes them, for a build whose
 * table does not have P1-05's definitions yet: the command still speaks
 * to a Daisy that has them.
 */
const CONTRACT: Record<string, { method: string; path: string }> = {
  [ROUTES.pinStatus]: { method: "GET", path: "/api/pin" },
  [ROUTES.pinGrant]: { method: "POST", path: "/api/pin/grant" },
};

export function routeOf(id: string): { method: string; path: string } | undefined {
  return API_ROUTES.find((r: AnyRoute) => r.id === id) ?? CONTRACT[id];
}

/** Call a route by id (with its path parameters filled). */
export function callRoute(
  d: Daisy,
  id: string,
  o: CallOptions & { params?: Record<string, string> } = {},
): Promise<Reply> {
  const r = routeOf(id);
  if (!r) {
    const e = new CliError(
      t("cli.routes.notDefined", { id }),
      t("cli.routes.notDefinedFix"),
      1,
      "route_not_defined",
    );
    (e as any).status = 404;
    return Promise.reject(e);
  }
  return d.call(r.method, fillPath(r.path, o.params), o);
}
