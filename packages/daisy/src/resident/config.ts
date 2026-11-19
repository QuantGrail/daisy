/**
 * P4-07 (总纲 5.2, 5.8, ADR-126): a resident agent's configuration as
 * stored (`resident_agents.data`), and what a Runner job of one of its
 * dedicated sessions is told (`residentLimits`).
 */
import type { Store } from "../store/index.ts";
import type { ResidentApprovals, ResidentAgentState, ResidentLayerKey } from "../../../contracts/src/api/residents.ts";
import { RESIDENT_AGENT_LIMITS } from "../../../contracts/src/api/residents.ts";
import type { RunnerJob } from "../../../contracts/src/index.ts";

export interface ResidentConfig {
  name: string;
  description: string;
  harness: string;
  workspaceId: string;
  profileId: string;
  nodeId: string;
  prompt: Record<ResidentLayerKey, string>;
  /** null: the identity's own mode. */
  permissionMode: string | null;
  dirs: string[];
  /** null: the harness's default set. */
  tools: string[] | null;
  concurrency: number;
  /** 0: unlimited. */
  dailyTurns: number;
  approvals: ResidentApprovals;
}

export interface ResidentRow {
  id: string;
  ownerId: string;
  config: ResidentConfig;
  state: ResidentAgentState;
  createdAt: number;
  updatedAt: number;
  pausedAt: number | null;
  closedAt: number | null;
}

/**
 * Which harnesses Daisy can hold to a list of tools and extra directories
 * (原则 4, 如实声明): Claude Code (`--tools`, `--add-dir`). The others have
 * no such launch setting Daisy drives — asking for one is refused
 * (`capability_unsupported`), not pretended.
 */
export const RESIDENT_TOOLS_HARNESSES: readonly string[] = ["claude"];

export function readResident(store: Store, id: string): ResidentRow | null {
  const r = store.one("SELECT * FROM resident_agents WHERE id=?", id);
  if (!r) return null;
  let config: ResidentConfig;
  try {
    config = JSON.parse(r.data);
  } catch {
    return null;
  }
  return {
    id: r.id,
    ownerId: r.owner_id,
    config: {
      ...config,
      concurrency: config.concurrency || RESIDENT_AGENT_LIMITS.concurrency.default,
      dirs: config.dirs ?? [],
      tools: config.tools ?? null,
      approvals: config.approvals ?? "reject",
      dailyTurns: config.dailyTurns ?? 0,
    },
    state: r.state,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    pausedAt: r.paused_at ?? null,
    closedAt: r.closed_at ?? null,
  };
}

/**
 * What the Runner is told for a turn of a dedicated session (job-payload).
 * An agent no longer there (deleted under a turn already claimed): no
 * extra tools or directories, and approvals declined.
 */
export function residentLimitsOf(store: Store, agentId: string): NonNullable<RunnerJob["residentLimits"]> {
  const r = readResident(store, agentId);
  if (!r) return { tools: null, dirs: [], declineApprovals: true };
  const supports = RESIDENT_TOOLS_HARNESSES.includes(r.config.harness);
  return {
    tools: supports ? r.config.tools : null,
    dirs: supports ? r.config.dirs : [],
    declineApprovals: r.config.approvals !== "owner",
  };
}
