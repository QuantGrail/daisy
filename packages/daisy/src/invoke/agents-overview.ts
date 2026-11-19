/**
 * P4-12 (总纲 5.2, 5.10 「三种 agent 与开放范围」, ADR-132): `GET /api/agents`
 * — the agents others may call, one list for the web page and `daisy
 * agent list`: public sessions (P4-06) and resident agents (P4-07), each
 * with its range (P4-03), 是否允许办 (P4-05, public agents) and how many
 * call cards wait on it and grants stand on it. A read in the 「调用授权」
 * group: `daisy:grant`, the PIN on the command line only (D-40 ①) — the AI and visitors read none of it.
 */
import type { FastifyInstance } from "fastify";
import { api } from "../../../contracts/src/api/index.ts";
import type { AgentOverview } from "../../../contracts/src/api/outgoing.ts";
import type { Store } from "../store/index.ts";
import { serve } from "../app/serve.ts";
import type { InvokeAccess } from "./invoke-access.ts";

export interface AgentsOverviewDeps {
  store: Store;
  invoke: InvokeAccess;
  /** Public sessions (P4-06): ids in the order they were made public. */
  publicIds: () => string[];
  /** 是否允许办 of a public agent (P4-05 AskAct.settings). */
  actOf: (agentId: string, harness: string) => boolean;
  /** Resident agents (P4-07), every state. */
  residents: () => { id: string; name: string; state: "running" | "paused" | "closed"; createdAt: number }[];
}

export function agentsOverview(d: AgentsOverviewDeps): AgentOverview[] {
  const count = (sql: string, id: string) => Number(d.store.one(sql, id)?.n ?? 0);
  const common = (id: string) => {
    // A closed resident is nobody's agent any more (its range is not read).
    let a: { openTo: "all" | "listed"; listed: unknown[] } = { openTo: "all", listed: [] };
    try {
      a = d.invoke.audience(id);
    } catch {}
    return {
      openTo: a.openTo,
      listed: a.listed.length,
      pending: count("SELECT COUNT(*) n FROM invoke_requests WHERE agent_id=? AND status='pending'", id),
      grants: count("SELECT COUNT(*) n FROM invoke_grants WHERE agent_id=?", id),
    };
  };
  const out: AgentOverview[] = [];
  for (const id of d.publicIds()) {
    const s = d.store.session(id);
    if (!s || s.deleting) continue;
    const since = Number(d.store.one("SELECT since FROM public_agents WHERE session_id=?", id)?.since ?? 0);
    out.push({
      id,
      kind: "public",
      name: s.title || id,
      sessionId: id,
      state: "running",
      since,
      act: d.actOf(id, s.agent),
      ...common(id),
    });
  }
  for (const r of d.residents())
    out.push({
      id: r.id,
      kind: "resident",
      name: r.name,
      sessionId: null,
      state: r.state,
      since: r.createdAt,
      act: null,
      ...common(r.id),
    });
  return out;
}

export function registerAgentsOverviewRoute(app: FastifyInstance, d: AgentsOverviewDeps): void {
  serve(app, api.agents.agentList, async () => ({ agents: agentsOverview(d) }));
}
