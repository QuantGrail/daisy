import { z } from "zod";
import { randomBytes } from "node:crypto";
import { basename } from "node:path";
import { id, type Store } from "../store/index.ts";
import type { RunnerPort } from "./runner-port.ts";
import { api } from "../../../contracts/src/api/index.ts";
import { serve } from "./serve.ts";
import type { MessageKey, Translate } from "../../../contracts/src/i18n.ts";
import { ownerT } from "../platform/language.ts";
import { LocalizedError } from "./errors.ts";
import { requestT } from "./language.ts";
import { namedFor } from "../platform/default-names.ts";
const fail = (statusCode: number, code: string, key: MessageKey): never => {
  throw new LocalizedError(statusCode, code, key);
};
/** A result the server wrote itself (a timed-out request): its key, said when read. */
const TIMED_OUT: MessageKey = "server-app.directory.nodeTimeout";
export function filesystemRoutes(
  app: any,
  /** P1-02: the in-process Runner's calls (were /api/runner/*). */
  runner: RunnerPort,
  store: Store,
  user: (r: any) => any,
  node: (r: any) => any,
  usableNode: (u: any, nodeId: string) => any,
  claimingNode: (r: any) => any = node,
) {
  const reap = () => {
    store.run(
      "UPDATE filesystem_requests SET status='error',result=? WHERE expires<? AND status IN ('queued','running')",
      JSON.stringify({ error: ownerT().dynamic(TIMED_OUT), errorKey: TIMED_OUT }),
      Date.now(),
    );
    store.run(
      "DELETE FROM filesystem_requests WHERE expires<?",
      Date.now() - 300_000,
    );
  };
  const view = (r: any, t: Translate) => {
    const { errorKey, ...result } = r.result ? JSON.parse(r.result) : ({} as Record<string, unknown>);
    // The server's own words are said in the reader's language (an older row has only `error`).
    if (typeof errorKey === "string") result.error = t.dynamic(errorKey);
    // P6-28: the workspace's name as stored ("" for Daisy's own) → the reader's language.
    const w = result.workspace as { label?: unknown } | undefined;
    if (w && typeof w === "object") result.workspace = { ...w, ...namedFor("workspace", w.label, t) };
    return { id: r.id, status: r.status, ...result };
  };
  const W = api.workspaces;
  serve(app, W.browse, async (req: any) => {
    const u = user(req),
      nid = req.params.id,
      b = W.browse.body.parse(req.body);
    const n = usableNode(u, nid);
    if (Date.now() - n.last_seen > 30000)
      fail(503, "node_offline", "server-app.directory.nodeOffline");
    reap();
    if (
      store.one(
        "SELECT COUNT(*) AS n FROM filesystem_requests WHERE owner_id=? AND status IN ('queued','running')",
        u.id,
      ).n >= 5
    )
      fail(429, "too_many_requests", "server-app.directory.tooMany");
    const request = { id: id(), status: "queued" };
    store.run(
      "INSERT INTO filesystem_requests(id,owner_id,node_id,operation,input,status,expires) VALUES(?,?,?,?,?,?,?)",
      request.id,
      u.id,
      nid,
      b.operation,
      JSON.stringify(b),
      request.status,
      Date.now() + 30000,
    );
    return request;
  });
  serve(app, W.browseResult, async (req: any) => {
    const u = user(req);
    reap();
    const r = store.one(
      "SELECT * FROM filesystem_requests WHERE id=? AND owner_id=?",
      req.params.id,
      u.id,
    );
    if (!r) fail(404, "directory_request_not_found", "server-app.directory.notFound");
    return view(r, requestT(req));
  });
  runner.post("/filesystem/claim", async (req: any) => {
    const n = claimingNode(req);
    reap();
    return store.atomic(() => {
      const r = store.one(
        "SELECT * FROM filesystem_requests WHERE node_id=? AND status='queued' ORDER BY rowid LIMIT 1",
        n.id,
      );
      if (!r) return { request: null };
      const lease = randomBytes(24).toString("base64url");
      store.run(
        "UPDATE filesystem_requests SET status='running',lease=? WHERE id=?",
        lease,
        r.id,
      );
      return { request: { id: r.id, lease, ...JSON.parse(r.input) } };
    });
  });
  runner.post("/filesystem/:id/complete", async (req: any) => {
    const n = node(req);
    reap();
    const r = store.one(
      "SELECT * FROM filesystem_requests WHERE id=?",
      req.params.id,
    );
    if (!r || r.node_id !== n.id || r.lease !== req.headers["x-lease"])
      fail(409, "lease_invalid", "server-app.directory.leaseInvalid");
    if (r.status === "complete") return { ok: true };
    if (r.status !== "running") fail(409, "directory_request_closed", "server-app.directory.closed");
    const b = z
      .object({
        error: z.string().max(2000).optional(),
        listing: z
          .object({
            path: z.string().max(4096),
            home: z.string().max(4096),
            roots: z.array(z.string().max(4096)).max(100),
            parent: z.string().max(4096).nullable(),
            entries: z
              .array(
                z.object({
                  name: z.string().max(1000),
                  path: z.string().max(4096),
                  symlink: z.boolean(),
                }),
              )
              .max(150),
            nextOffset: z.number().int().nullable(),
          })
          .optional(),
        directory: z
          .object({ path: z.string().min(1).max(4096), created: z.boolean() })
          .optional(),
      })
      .parse(req.body);
    if (
      !b.error &&
      ((r.operation === "browse" && !b.listing) ||
        (r.operation === "ensure" && !b.directory))
    )
      fail(400, "invalid_input", "server-app.directory.noResult");
    return store.atomic(() => {
      let result: any = b;
      if (!b.error && r.operation === "ensure") {
        const path = b.directory!.path;
        let w = store.one(
          "SELECT * FROM workspaces WHERE node_id=? AND path=? ORDER BY rowid LIMIT 1",
          n.id,
          path,
        );
        if (!w) {
          const wid = id();
          store.run(
            "INSERT INTO workspaces VALUES(?,?,?,?)",
            wid,
            n.id,
            basename(path) || path,
            path,
          );
          w = store.one("SELECT * FROM workspaces WHERE id=?", wid);
        }
        result = {
          workspace: {
            id: w.id,
            nodeId: w.node_id,
            label: w.label,
            path: w.path,
          },
          created: b.directory!.created,
        };
        store.audit(r.owner_id, "workspace.select", w.id);
      }
      store.run(
        "UPDATE filesystem_requests SET status=?,result=? WHERE id=?",
        b.error ? "error" : "complete",
        JSON.stringify(result),
        r.id,
      );
      return { ok: true };
    });
  });
}
