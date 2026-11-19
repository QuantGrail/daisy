import { posix, win32 } from "node:path";

type PathRules = typeof posix;
/** No trailing separator, except on a root (`/`, `C:\\`). */
export function stripTrailing(P: PathRules, p: string): string {
  const root = P.parse(p).root;
  return p.length > root.length ? p.replace(/[\\/]+$/, "") : p;
}
/** `path` is `root` or inside it (Windows: case-insensitive, either separator). */
export function within(P: PathRules, root: string, path: string): boolean {
  if (!P.isAbsolute(root)) return false;
  const r = P.relative(P.normalize(root), path);
  return r === "" || (r !== ".." && !r.startsWith(".." + P.sep) && !P.isAbsolute(r));
}
import type { FastifyInstance } from "fastify";
import { id } from "../store/index.ts";
import { LocalizedError } from "./errors.ts";
import { requestT } from "./language.ts";
import { namedFor } from "../platform/default-names.ts";
import { serve } from "./serve.ts";
import { api } from "../../../contracts/src/api/index.ts";
import type { AppContext } from "./context.ts";
/**
 * What a person picks from (nodes, workspaces, identities) and adding a
 * workspace (P1-00: moved from app.ts).
 */
export function registerWorkspaceRoutes(
  app: FastifyInstance,
  ctx: AppContext,
): void {
  const {
    store,
    lifecycle,
    user,
    canUseNode,
    nodeView,
    usableNode,
    profileView,
  } = ctx;
  const W = api.workspaces;
  serve(app, W.catalog, async (req) => {
    const u = user(req),
      nodes = store.all("SELECT * FROM nodes").filter((n) => canUseNode(u, n)),
      ids = new Set(nodes.map((n) => n.id)),
      // P6-28: Daisy's own names in the request's language.
      t = requestT(req);
    return {
      // The control plane's release, for the node table's version column.
      release: lifecycle.release,
      nodes: nodes.map((n) => nodeView(n, t)),
      workspaces: store
        .all("SELECT * FROM workspaces")
        .filter((w) => ids.has(w.node_id))
        .map((w) => ({
          id: w.id,
          nodeId: w.node_id,
          ...namedFor("workspace", w.label, t),
          path: w.path,
        })),
      profiles: store
        .all("SELECT * FROM profiles WHERE owner_id=?", u.id)
        .map((r) => profileView(r, t)),
    };
  });
  serve(app, W.add, async (req) => {
    const u = user(req);
    const b = W.add.body.parse(req.body);
    const n = usableNode(u, b.nodeId);
    // Manual registration: an absolute, normalised path inside the roots the
    // node reported. (The folder picker's ensure flow resolves real paths on
    // the node; the runner re-checks realpath + allowedRoots on every run.)
    // P5-05: the node is this machine — its own path rules (Windows: C:\…).
    const P = process.platform === "win32" ? win32 : posix;
    if (!P.isAbsolute(b.path) || /[\x00-\x1f\x7f]/.test(b.path))
      throw new LocalizedError(400, "workspace_path_invalid", "server-app.workspace.notAbsolute");
    const path = stripTrailing(P, P.normalize(b.path));
    const roots: unknown = JSON.parse(n.capabilities || "{}").filesystem?.roots;
    if (
      Array.isArray(roots) &&
      roots.length &&
      !roots.some((r) => typeof r === "string" && within(P, r, path))
    )
      throw new LocalizedError(400, "workspace_outside_roots", "server-app.workspace.outsideRoots", {
        roots: roots.join(requestT(req)("server.list.separator")),
      });
    const wid = id();
    store.run(
      "INSERT INTO workspaces VALUES(?,?,?,?)",
      wid,
      b.nodeId,
      b.label,
      path,
    );
    return { id: wid, ...b, path };
  });
}
