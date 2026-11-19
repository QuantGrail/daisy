/**
 * P4-03 (总纲 5.2 开放范围, 5.4 「被别的智能体调用」, 5.6 调用授权, 5.10
 * `daisy request`, 5.11, D-15, D-19, ADR-122): call authorization — who
 * may call which of my agents.
 *
 * One grant per agent × person (D-19: one way, not passed on, only the
 * call, revocable). An agent open to all contacts asks the owner the
 * first time with a card (永久通过 / 仅本次 / 拒绝, 7 days); one open to
 * listed people only lets those in and nobody else; a private agent
 * nobody. Strangers and people outside the range are refused with no card.
 *
 * Routes: the 「调用授权」 group, `daisy:grant` throughout (scopes.md §2).
 * Deciding a request, revoking a grant and changing who an agent is open
 * to let others in (5.11 「要」) — `letsIn` (P4-02), at the places
 * reserved for them (`/api/requests…`, `/api/grants…`, `/api/agents…`).
 * Reading takes the PIN on the command line only (D-40 ①, phase-4 gate,
 * `PIN_ON_CLI`: that credential may be the owner's AI) and still
 * `daisy:grant` on the owner's channels — the AI's
 * working credential and visitors read none of it. The pending cards are
 * also in the 「审批」 list (`GET /api/approvals`, `kind: "call"`).
 *
 * packages/daisy/src/invoke/routes.ts.
 */
import { z } from "zod";
import type { Translate } from "../i18n.ts";
import { defaultTranslate } from "../i18n-default.ts";
import { cmd, group, json, route, PIN_ON_CLI } from "./route.ts";

/** 5.6 卡片上的三个选择. */
export const INVOKE_DECISIONS = ["always", "once", "reject"] as const;
export type InvokeDecisionKey = (typeof INVOKE_DECISIONS)[number];
/** Who calls: a contact (P4-01), or a person the external issuer named. */
export interface InvokePerson {
  /**
   * The grant's key: the contact's identity number, or (an external
   * issuer's person) `sub:` + a hash of the issuer and the whole `sub` —
   * the same `sub` under another issuer is another person.
   */
  key: string;
  /** The contact's identity number; null for an external issuer's person. */
  contactId: string | null;
  /** The external issuer that vouched for this person; null for a contact. */
  issuer: string | null;
  /** The person's `sub` (a contact's URN; an issuer's subject, cut to 200 characters). */
  subject: string;
  /** Display name: the contact's card name, else the subject marked 「（外部签发方）」. */
  name: string;
}

/** A pending (or decided) call request — the card (5.6). */
export interface InvokeRequest {
  /** `call:<uuid>` — the same id the 「审批」 list (`kind: "call"`) and the event outlet use. */
  id: string;
  status: "pending" | "approved" | "rejected" | "expired" | "canceled";
  agent: { id: string; name: string; sessionId: string | null };
  caller: InvokePerson & {
    /** The caller's AI that made the first call (`act.sub`), when its token said. */
    actor: string | null;
  };
  created: number;
  /** created + 7 days (limits.md §1). */
  expiresAt: number;
  /** How many calls joined this card in all (the first included). */
  calls: number;
  /** How many are waiting on it now (at most `CARD_LIMITS.callCardMaxWaiting`). */
  waiting: number;
  /** The distinct AIs (`act.sub`) behind the calls on it, cleaned and cut. */
  actors: string[];
  options: { key: InvokeDecisionKey; label: string }[];
  decision: {
    choice: InvokeDecisionKey;
    label: string;
    note: string | null;
    by: string;
    at: number;
  } | null;
  /** Why it ended without a decision (expired, canceled): one sentence. */
  closedWhy: string | null;
}

/** One standing grant: this person may call this agent (5.6 永久通过). */
export interface InvokeGrant {
  id: string;
  agent: { id: string; name: string };
  person: InvokePerson;
  grantedAt: number;
  /** The card it came from (`call:<uuid>`). */
  requestId: string | null;
}

/** 5.2 开放范围 of one agent. */
export interface AgentAudience {
  agentId: string;
  /** Whether the agent can be called at all (P4-06 / P4-07 decide; `private` until then). */
  kind: "private" | "public" | "resident";
  /** 对所有互认的人开放 / 只对指定人开放. */
  openTo: "all" | "listed";
  /** The named people (contacts), for `listed`. Kept when switching to `all`. */
  listed: InvokePerson[];
  /** Did the owner set it (false: the default, `all`). */
  set: boolean;
  updatedAt: number | null;
}

/**
 * P4-05 (总纲 5.7 问与办, a2a-usage.md §8.1 / §13, D-28, ADR-124): how one
 * agent takes 「问」 and 「办」 from others. Two settings are the owner's
 * (`act`, `permissionMode`); the rest is what the harness and its device
 * declare (P4-11 capabilities), shown so the owner sees what callers get.
 */
export interface AgentAskAct {
  agentId: string;
  kind: "private" | "public" | "resident";
  /** 是否允许办: false → calls marked 办 are rejected `ACT_DISABLED`; 问 still works. */
  act: boolean;
  /**
   * The permission mode 办 runs with: one of `modes`, or null = the
   * session's own (its identity's). Never a mode that skips every
   * confirmation.
   */
  permissionMode: string | null;
  /** The modes 办 may be given (the harness's, minus its bypass mode). */
  modes: string[];
  /** How a 「问」 runs on this agent now. */
  ask: {
    /** a2a-usage.md §8.1 `params.readOnly`: strong, weak (D-28), or none (no 问: `ASK_NOT_SUPPORTED`). */
    readOnly: "strong" | "weak" | "none";
    /** `branch` (read-only side branch), `main-queue` (no side question / fork: the main line, read-only), null (no 问). */
    ranOn: "branch" | "main-queue" | null;
    /** Why not on a branch / why no 问 at all (one sentence), else null. */
    why: string | null;
  };
  /** Did the owner set it (false: the defaults). */
  set: boolean;
  updatedAt: number | null;
}

/**
 * P4-06 (总纲 5.2 「公开 agent 会串话」, 5.7, ADR-125): what the owner is
 * told before making a session public — the same words on the web page,
 * in the command's answer and in the docs.
 */
export const crossTalkNote = (t: Translate = defaultTranslate()): string => t("server-a2a.public.crossTalk");

/** P4-06 (ADR-125): a session as a public agent (`GET /api/sessions/:id/public`). */
export interface SessionPublic {
  sessionId: string;
  /** Callable by others (within its range, 5.2) — a public agent. False: private (only its owner). */
  public: boolean;
  /** When it was made public (null: private). */
  since: number | null;
  /** 是否允许办 now (P4-05 settings; the default is on). */
  act: boolean;
  /** How a 「问」 would run on it now (P4-05 `AgentAskAct.ask`). */
  ask: AgentAskAct["ask"];
  /**
   * Why it cannot be made public now (null: it can, or it already is):
   * archived, an identity that skips every confirmation, a
   * hidden branch or a resident, or no read-only mode with 办 off (5.7).
   */
  blocked: string | null;
  /** `crossTalkNote`: what making it public means. */
  crossTalk: string;
}

const ref = z.string().min(1).max(200);

export const InvokeDecideSchema = z
  .object({
    decision: z
      .enum(INVOKE_DECISIONS)
      .describe("api.field.invoke.decision"),
    note: z.string().max(2000).optional().describe("api.field.invoke.note"),
  })
  .strict();

export const AudienceSetSchema = z
  .object({
    openTo: z
      .enum(["all", "listed"])
      .describe("api.field.invoke.openTo"),
    listed: z
      .array(ref)
      .max(500)
      .optional()
      .describe("api.field.invoke.listed"),
  })
  .strict();

export const AskActSetSchema = z
  .object({
    act: z
      .boolean()
      .optional()
      .describe("api.field.invoke.act"),
    permissionMode: z
      .string()
      .min(1)
      .max(40)
      .optional()
      .describe("api.field.invoke.permissionMode"),
  })
  .strict()
  .refine((b) => b.act !== undefined || b.permissionMode !== undefined, "api.validation.actOrPermissionMode");

export const PublicSetSchema = z
  .object({
    public: z
      .boolean()
      .describe("api.field.invoke.public"),
  })
  .strict();

export const invoke = group("grant", {
  requestList: route({
    method: "GET",
    path: "/api/requests",
    scope: "daisy:grant",
    ...PIN_ON_CLI,
    query: z
      .object({
        status: z.enum(["pending", "decided", "all"]).default("pending").describe("api.route.grant.requestList.field.status"),
        limit: z.coerce.number().int().min(1).max(200).default(100).describe("api.route.grant.requestList.field.limit"),
      })
      .strict(),
    output: json<{ requests: InvokeRequest[] }>("{ requests: InvokeRequest[] }"),
    cli: cmd("request list"),
  }),
  requestShow: route({
    method: "GET",
    path: "/api/requests/:rid",
    scope: "daisy:grant",
    ...PIN_ON_CLI,
    params: z.object({ rid: ref.describe("api.route.grant.requestShow.field.rid") }).strict(),
    output: json<InvokeRequest>("InvokeRequest"),
    errors: ["request_not_found"],
    cli: cmd("request show"),
  }),
  requestDecide: route({
    method: "POST",
    path: "/api/requests/:rid/decision",
    scope: "daisy:grant",
    letsIn: "invoke-request",
    params: z.object({ rid: ref.describe("api.route.grant.requestDecide.field.rid") }).strict(),
    body: InvokeDecideSchema,
    output: json<InvokeRequest>("InvokeRequest"),
    errors: ["pin_required", "request_not_found", "request_closed", "request_stale"],
    cli: cmd("request decide", { args: ["rid", "decision"] }),
  }),
  grantList: route({
    method: "GET",
    path: "/api/grants",
    scope: "daisy:grant",
    ...PIN_ON_CLI,
    query: z
      .object({
        agent: ref.optional().describe("api.route.grant.grantList.field.agent"),
        contact: ref.optional().describe("api.route.grant.grantList.field.contact"),
      })
      .strict(),
    output: json<{ grants: InvokeGrant[] }>("{ grants: InvokeGrant[] }"),
    cli: cmd("grant list"),
  }),
  grantRevoke: route({
    method: "DELETE",
    path: "/api/grants/:gid",
    scope: "daisy:grant",
    letsIn: "invoke-grant",
    params: z.object({ gid: ref.describe("api.route.grant.grantRevoke.field.gid") }).strict(),
    output: json<{ revoked: InvokeGrant; stopped: number }>("{ revoked: InvokeGrant, stopped }"),
    errors: ["pin_required", "grant_not_found"],
    cli: cmd("grant revoke"),
  }),
  audienceShow: route({
    method: "GET",
    path: "/api/agents/:aid/audience",
    scope: "daisy:grant",
    ...PIN_ON_CLI,
    params: z.object({ aid: ref.describe("api.route.grant.audienceShow.field.aid") }).strict(),
    output: json<AgentAudience>("AgentAudience"),
    errors: ["agent_not_found"],
    cli: cmd("agent audience show"),
  }),
  audienceSet: route({
    method: "PUT",
    path: "/api/agents/:aid/audience",
    scope: "daisy:grant",
    letsIn: "agent-audience",
    params: z.object({ aid: ref.describe("api.route.grant.audienceSet.field.aid") }).strict(),
    body: AudienceSetSchema,
    output: json<AgentAudience & { stopped: number }>("AgentAudience & { stopped }"),
    errors: ["pin_required", "agent_not_found", "contact_not_found", "contact_ambiguous"],
    cli: cmd("agent audience set"),
  }),
  // P4-06 (ADR-125): 把会话设为公开或收回 (5.2, 5.11 「把会话设为公开」).
  publicSet: route({
    method: "PUT",
    path: "/api/sessions/:id/public",
    scope: "daisy:grant",
    letsIn: "agent-exposure",
    params: z.object({ id: ref.describe("api.route.grant.publicSet.field.id") }).strict(),
    body: PublicSetSchema,
    output: json<SessionPublic & { stopped: number }>("SessionPublic & { stopped }"),
    errors: ["pin_required", "session_archived", "not_publishable", "bypass_not_private", "act_required", "not_session_owner", "session_not_found"],
    cli: cmd("agent public set", { args: ["id", "public"] }),
  }),
  // P4-05 (ADR-124): 问与办 — 是否允许办、办的权限模式 (5.7, 5.11 「设置是否允许办」).
  actShow: route({
    method: "GET",
    path: "/api/agents/:aid/act",
    scope: "daisy:grant",
    ...PIN_ON_CLI,
    params: z.object({ aid: ref.describe("api.route.grant.actShow.field.aid") }).strict(),
    output: json<AgentAskAct>("AgentAskAct"),
    errors: ["agent_not_found"],
    cli: cmd("agent act show"),
  }),
  actSet: route({
    method: "PUT",
    path: "/api/agents/:aid/act",
    scope: "daisy:grant",
    letsIn: "agent-exposure",
    params: z.object({ aid: ref.describe("api.route.grant.actSet.field.aid") }).strict(),
    body: AskActSetSchema,
    output: json<AgentAskAct & { withdrawn: number }>("AgentAskAct & { withdrawn }"),
    errors: ["pin_required", "agent_not_found", "mode_not_allowed", "act_required"],
    cli: cmd("agent act set"),
  }),
});
