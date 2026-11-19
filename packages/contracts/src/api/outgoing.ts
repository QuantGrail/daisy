/**
 * P4-12 (ADR-132): two read-only overviews the web page and the command
 * line share.
 *
 * - 「我的 AI 调用了谁」 (`GET /api/calls…`, the 「会话」 group): every task
 *   my AIs asked of another Daisy's agent (P4-08's `a2a_calls`, ADR-127 —
 *   who, which agent, 问 or 办, the state, the answer, the trace). The
 *   owner reads it like a conversation's record: `daisy:session:read`, no
 *   PIN, not the AI (it has `call_result` for its own calls). Nothing here
 *   lets anyone in; a read at a path no 「放别人进来」 kind keeps.
 * - 「我的 agent」 (`GET /api/agents`, the 「调用授权」 group): the agents
 *   others may call — public sessions (P4-06) and resident agents (P4-07)
 *   — with their range (P4-03), 问与办 (P4-05) and how many cards and
 *   grants each has. Every other session is a private agent. Reading takes
 *   the PIN on the command line only (D-40 ①, `PIN_ON_CLI`), still `daisy:grant`: the AI reads none of it.
 *
 * packages/daisy/src/a2a/outgoing-routes.ts, packages/daisy/src/invoke/agents-overview.ts.
 */
import { z } from "zod";
import { cmd, group, json, route, PIN_ON_CLI } from "./route.ts";

/** One call my AI made (P4-08 `a2a_calls`). */
export interface OutgoingCall {
  id: string;
  /** My AI that made it. */
  session: { id: string; title: string };
  /** Whose agent: the contact (P4-01) and their agent's id / name. */
  contact: { id: string; name: string };
  agent: { id: string; name: string };
  mode: "ask" | "act";
  /** What my AI sent (the text of its last message, cut). */
  text: string;
  /** A2A TaskState, `sending` (on its way) or `error` (ended here without the other side's task). */
  state: string;
  /** The state in words. */
  stateLabel: string;
  /** Why it ended (a reason code), when the other side or Daisy said. */
  reason: string | null;
  /** The other side's status message (or why it failed here). */
  statusText: string | null;
  /** The answer's text (completed), cut in the list; whole in `show`. */
  answer: string | null;
  /** Names of files the answer carried (not fetched, ADR-127 decision 6). */
  files: string[];
  /** The other side's ids (opaque). */
  contextId: string | null;
  taskId: string | null;
  traceId: string;
  depth: number;
  created: number;
  updated: number;
  /** Network failures in a row while polling, and when it is polled next (null: not). */
  failures: number;
  nextAt: number | null;
}

/** One agent others may call (5.2: public or resident). */
export interface AgentOverview {
  id: string;
  kind: "public" | "resident";
  name: string;
  /** The session behind a public agent (null for a resident). */
  sessionId: string | null;
  /** A resident's state; a public agent is `running` while public. */
  state: "running" | "paused" | "closed";
  /** Public: when it was made public; resident: when it was created. */
  since: number;
  /** 5.2 开放范围. */
  openTo: "all" | "listed";
  /** How many people are named (for `listed`). */
  listed: number;
  /** 是否允许办 (public agents; null for a resident — its own configuration decides). */
  act: boolean | null;
  /** Call cards waiting for the owner on this agent. */
  pending: number;
  /** Standing grants (永久通过) on this agent. */
  grants: number;
}

const ref = z.string().min(1).max(200);

export const outgoing = group("session", {
  outgoingList: route({
    method: "GET",
    path: "/api/calls",
    scope: "daisy:session:read",
    query: z
      .object({
        session: ref.optional().describe("api.route.session.outgoingList.field.session"),
        contact: ref.optional().describe("api.route.session.outgoingList.field.contact"),
        state: z.enum(["open", "settled", "all"]).default("all").describe("api.route.session.outgoingList.field.state"),
        limit: z.coerce.number().int().min(1).max(200).default(50).describe("api.route.session.outgoingList.field.limit"),
      })
      .strict(),
    output: json<{ calls: OutgoingCall[] }>("{ calls: OutgoingCall[] }"),
    cli: cmd("call list"),
  }),
  outgoingShow: route({
    method: "GET",
    path: "/api/calls/:cid",
    scope: "daisy:session:read",
    params: z.object({ cid: ref.describe("api.route.session.outgoingShow.field.cid") }).strict(),
    output: json<OutgoingCall>("OutgoingCall"),
    errors: ["call_not_found"],
    cli: cmd("call show"),
  }),
});

export const agents = group("grant", {
  agentList: route({
    method: "GET",
    path: "/api/agents",
    scope: "daisy:grant",
    ...PIN_ON_CLI,
    output: json<{ agents: AgentOverview[] }>("{ agents: AgentOverview[] }"),
    cli: cmd("agent list"),
  }),
});
