/**
 * P1-06: workspaces and folder browsing — the routes of
 * packages/daisy/src/app/workspaces.ts and filesystem.ts.
 */
import { z } from "zod";
import { cmd, group, json, route } from "./route.ts";
import type { Catalog, DirectoryListing, Workspace } from "../workspace.ts";

/** A folder request's state and, once done, its result (filesystem.ts `view`). */
export interface FolderRequest {
  id: string;
  status: "queued" | "running" | "complete" | "error";
  error?: string;
  /** browse: the listing. */
  listing?: DirectoryListing;
  /** ensure: the workspace registered for the folder. */
  workspace?: Workspace;
  created?: boolean;
}

export const workspaces = group("workspace", {
  catalog: route({
    method: "GET",
    path: "/api/catalog",
    scope: "daisy:manage",
    output: json<Catalog>("Catalog"),
    cli: cmd("workspace catalog"),
  }),
  add: route({
    method: "POST",
    path: "/api/workspaces",
    scope: "daisy:manage",
    body: z.object({
      nodeId: z.string().describe("api.route.workspace.add.field.nodeId"),
      label: z.string().min(1).max(100).describe("api.route.workspace.add.field.label"),
      path: z.string().min(1).max(2000).describe("api.route.workspace.add.field.path"),
    }),
    output: json<Workspace>("Workspace"),
    errors: ["node_not_found", "node_revoked", "workspace_outside_roots", "workspace_path_invalid"],
    cli: cmd("workspace add"),
  }),
  browse: route({
    method: "POST",
    path: "/api/nodes/:id/filesystem",
    scope: "daisy:manage",
    external: "browse",
    params: z.object({ id: z.string().describe("api.route.workspace.browse.field.id") }),
    body: z.object({
      operation: z
        .enum(["browse", "ensure"])
        .describe("api.route.workspace.browse.field.operation"),
      path: z.string().max(4096).default("").describe("api.route.workspace.browse.field.path"),
      offset: z
        .number()
        .int()
        .min(0)
        .max(1000000)
        .default(0)
        .describe("api.route.workspace.browse.field.offset"),
      hidden: z.boolean().default(false).describe("api.route.workspace.browse.field.hidden"),
    }),
    output: json<{ id: string; status: "queued" }>("{ id, status }"),
    errors: ["node_not_found", "node_offline", "node_revoked", "too_many_requests"],
    cli: cmd("workspace browse"),
  }),
  browseResult: route({
    method: "GET",
    path: "/api/filesystem/:id",
    scope: "daisy:manage",
    external: "browse",
    params: z.object({ id: z.string().describe("api.route.workspace.browseResult.field.id") }),
    output: json<FolderRequest>("FolderRequest"),
    errors: ["directory_request_not_found"],
    cli: cmd("workspace browse-result"),
  }),
});
