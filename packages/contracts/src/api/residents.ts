/**
 * P4-07 (总纲 5.2 常驻 agent, 5.8, 5.10 `daisy agent`, 5.11, ADR-126): a
 * resident agent is a configuration — which harness, workspace and
 * identity, a layered prompt, the permission mode, the directories and
 * tools it may use, how many visiting conversations run at once and how
 * many turns a day. Each visiting conversation (A2A contextId) gets a
 * session of its own; the conversations cannot see each other.
 *
 * Routes: in the 「调用授权」 group (`daisy:grant` throughout). Creating,
 * changing and resuming one let others in (5.11 「创建、修改常驻 agent」,
 * `letsIn: "agent-exposure"`, PIN); pausing, closing and deleting only
 * take away (`notLetIn`, no PIN — ADR-126 §6, ADR-121 §7 item 4). Reading
 * takes the PIN on the command line only (D-40 ①, `PIN_ON_CLI`), still `daisy:grant`: the AI reads none of it.
 *
 * packages/daisy/src/resident/routes.ts.
 */
import { z } from "zod";
import { cmd, group, json, route, PIN_ON_CLI } from "./route.ts";

/** limits.md §4: default 4 conversations at once; a day's turns unlimited unless set (≤ 1000). */
export const RESIDENT_AGENT_LIMITS = {
  nameMax: 64,
  descriptionMax: 500,
  layerMax: 20_000,
  concurrency: { default: 4, min: 1, max: 32 },
  dailyTurnsMax: 1000,
  dirsMax: 20,
  toolsMax: 64,
} as const;

/** The owner's three layers on top of Daisy's own (ADR-126 §3). */
export const RESIDENT_LAYERS = ["role", "instructions", "knowledge"] as const;
export type ResidentLayerKey = (typeof RESIDENT_LAYERS)[number];

/** What happens to an operation auto mode still asks a person about (5.8 table, A-3). */
export const RESIDENT_APPROVALS = ["reject", "owner"] as const;
export type ResidentApprovals = (typeof RESIDENT_APPROVALS)[number];

export type ResidentAgentState = "running" | "paused" | "closed";

/** One visiting conversation's dedicated session. */
export interface ResidentConversation {
  contextId: string;
  sessionId: string;
  /** Who started it (the A2A caller's name). */
  caller: string;
  createdAt: number;
  lastAt: number;
  /** When its session was closed (the agent closed, the owner archived it); null: open. */
  closedAt: number | null;
}

export interface ResidentAgentView {
  id: string;
  name: string;
  description: string;
  harness: string;
  workspaceId: string;
  profileId: string;
  nodeId: string;
  /** The owner's layers (empty: not set). */
  prompt: Record<ResidentLayerKey, string>;
  /** All layers as the AI gets them, Daisy's first (locked). */
  layers: { id: "daisy" | ResidentLayerKey; title: string; text: string; editable: boolean }[];
  /** null: the identity's own mode. Never one that skips every confirmation. */
  permissionMode: string | null;
  /** The modes it may be given (the harness's, minus bypass). */
  modes: string[];
  /** Extra directories it may use besides the workspace (absolute). */
  dirs: string[];
  /** The harness's built-in tools it may use; null: the harness's default set. */
  tools: string[] | null;
  concurrency: number;
  /** Turns per 24 hours; 0: unlimited. */
  dailyTurns: number;
  approvals: ResidentApprovals;
  state: ResidentAgentState;
  createdAt: number;
  updatedAt: number;
  pausedAt: number | null;
  closedAt: number | null;
  usage: {
    /** Conversations with a turn in flight now. */
    active: number;
    /** Tasks waiting for a free place (A-19). */
    waiting: number;
    turnsToday: number;
  };
  /** The A2A address (relative to the face it is reached on). */
  a2aPath: string;
}

const id = z.string().min(1).max(200);
const text = (max: number) => z.string().max(max);
const absPath = z
  .string()
  .min(1)
  .max(1024)
  .refine((p) => /^(\/|[A-Za-z]:[\\/])/.test(p) && !p.includes("\0"), "api.validation.absolutePath");
const toolName = z
  .string()
  .min(1)
  .max(100)
  .regex(/^(\*|[A-Za-z][\w:-]*(\([^()\n]{0,200}\))?)$/, "api.validation.toolName");

const fields = {
  name: z.string().trim().min(1).max(RESIDENT_AGENT_LIMITS.nameMax).describe("api.field.residents.name"),
  description: text(RESIDENT_AGENT_LIMITS.descriptionMax).optional().describe("api.field.residents.description"),
  role: text(RESIDENT_AGENT_LIMITS.layerMax).optional().describe("api.field.residents.role"),
  instructions: text(RESIDENT_AGENT_LIMITS.layerMax).optional().describe("api.field.residents.instructions"),
  knowledge: text(RESIDENT_AGENT_LIMITS.layerMax).optional().describe("api.field.residents.knowledge"),
  permissionMode: z
    .string()
    .min(1)
    .max(40)
    .optional()
    .describe("api.field.residents.permissionMode"),
  dirs: z.array(absPath).max(RESIDENT_AGENT_LIMITS.dirsMax).optional().describe("api.field.residents.dirs"),
  tools: z
    .array(toolName)
    .max(RESIDENT_AGENT_LIMITS.toolsMax)
    .optional()
    .describe("api.field.residents.tools"),
  concurrency: z
    .number()
    .int()
    .min(RESIDENT_AGENT_LIMITS.concurrency.min)
    .max(RESIDENT_AGENT_LIMITS.concurrency.max)
    .optional()
    .describe("api.field.residents.concurrency"),
  dailyTurns: z
    .number()
    .int()
    .min(0)
    .max(RESIDENT_AGENT_LIMITS.dailyTurnsMax)
    .optional()
    .describe("api.field.residents.dailyTurns"),
  approvals: z
    .enum(RESIDENT_APPROVALS)
    .optional()
    .describe("api.field.residents.approvals"),
};

export const ResidentCreateSchema = z
  .object({
    ...fields,
    harness: z.string().min(1).max(64).describe("api.field.residents.harness"),
    workspaceId: id.describe("api.field.residents.workspaceId"),
    profileId: id.describe("api.field.residents.profileId"),
  })
  .strict();
export type ResidentCreate = z.input<typeof ResidentCreateSchema>;

export const ResidentSetSchema = z
  .object({
    name: fields.name.optional(),
    description: fields.description,
    role: fields.role,
    instructions: fields.instructions,
    knowledge: fields.knowledge,
    permissionMode: fields.permissionMode,
    dirs: fields.dirs,
    tools: fields.tools,
    concurrency: fields.concurrency,
    dailyTurns: fields.dailyTurns,
    approvals: fields.approvals,
  })
  .strict()
  .refine((b) => Object.values(b).some((v) => v !== undefined), "api.validation.changeSomething");
export type ResidentSet = z.input<typeof ResidentSetSchema>;

const aid = z.object({ aid: id.describe("api.field.residents.aid") }).strict();

export const residents = group("grant", {
  residentList: route({
    method: "GET",
    path: "/api/residents",
    scope: "daisy:grant",
    ...PIN_ON_CLI,
    output: json<{ residents: ResidentAgentView[] }>("{ residents: ResidentAgentView[] }"),
    cli: cmd("agent resident list"),
  }),
  residentShow: route({
    method: "GET",
    path: "/api/residents/:aid",
    scope: "daisy:grant",
    ...PIN_ON_CLI,
    params: aid,
    output: json<ResidentAgentView & { conversations: ResidentConversation[] }>("ResidentAgentView & { conversations }"),
    errors: ["agent_not_found"],
    cli: cmd("agent resident show"),
  }),
  residentCreate: route({
    method: "POST",
    path: "/api/residents",
    scope: "daisy:grant",
    letsIn: "agent-exposure",
    body: ResidentCreateSchema,
    output: json<ResidentAgentView>("ResidentAgentView"),
    errors: ["pin_required", "resident_invalid", "mode_not_allowed", "capability_unsupported", "bypass_not_private"],
    cli: cmd("agent resident create"),
  }),
  residentSet: route({
    method: "PATCH",
    path: "/api/residents/:aid",
    scope: "daisy:grant",
    letsIn: "agent-exposure",
    params: aid,
    body: ResidentSetSchema,
    output: json<ResidentAgentView>("ResidentAgentView"),
    errors: ["pin_required", "agent_not_found", "agent_closed", "mode_not_allowed", "capability_unsupported"],
    cli: cmd("agent resident set"),
  }),
  residentPause: route({
    method: "POST",
    path: "/api/residents/:aid/pause",
    scope: "daisy:grant",
    notLetIn: true,
    params: aid,
    output: json<ResidentAgentView & { refused: number }>("ResidentAgentView & { refused }"),
    errors: ["agent_not_found", "agent_closed"],
    cli: cmd("agent resident pause"),
  }),
  residentResume: route({
    method: "POST",
    path: "/api/residents/:aid/resume",
    scope: "daisy:grant",
    letsIn: "agent-exposure",
    params: aid,
    output: json<ResidentAgentView>("ResidentAgentView"),
    errors: ["pin_required", "agent_not_found", "agent_closed"],
    cli: cmd("agent resident resume"),
  }),
  residentClose: route({
    method: "POST",
    path: "/api/residents/:aid/close",
    scope: "daisy:grant",
    notLetIn: true,
    params: aid,
    output: json<ResidentAgentView & { stopped: number }>("ResidentAgentView & { stopped }"),
    errors: ["agent_not_found"],
    cli: cmd("agent resident close"),
  }),
  residentDelete: route({
    method: "DELETE",
    path: "/api/residents/:aid",
    scope: "daisy:grant",
    notLetIn: true,
    params: aid,
    output: json<{ ok: true; stopped: number; sessions: number }>("{ ok, stopped, sessions }"),
    errors: ["agent_not_found"],
    cli: cmd("agent resident delete"),
  }),
});
