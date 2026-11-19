import type { NodeInfo } from "./node.ts";
import type { Profile } from "./profile.ts";
// Workspaces and folder listings (P1-00: moved from index.ts).
export interface Workspace {
  id: string;
  nodeId: string;
  /** In the request's language when it is Daisy's own default name (P6-28). */
  label: string;
  /** The label is Daisy's default (the home folder): `shownName("workspace", …)` says it in another language. */
  labelDefault?: boolean;
  path: string;
}
export interface DirectoryListing {
  path: string;
  home: string;
  roots: string[];
  parent: string | null;
  entries: { name: string; path: string; symlink: boolean }[];
  nextOffset: number | null;
}
/**
 * What a person picks from: nodes, workspaces, own identities
 * (`GET /api/catalog`). P1-06: moved from the client package.
 */
export interface Catalog {
  profiles: Profile[];
  nodes: NodeInfo[];
  workspaces: Workspace[];
  /** The control plane's release commit, null in a checkout. */
  release?: string | null;
}
