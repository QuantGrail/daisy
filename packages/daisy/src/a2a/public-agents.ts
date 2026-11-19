/**
 * P4-06 公开 agent (总纲 5.2, 5.7, 5.11 「把会话设为公开」, D-18, ADR-125):
 * which of the owner's sessions others may call.
 *
 * A session is private until the owner (with the PIN: `letsIn:
 * "agent-exposure"`, written inside `commitLetIn`) makes it public; then
 *
 *   - the call authorization resolves it as `kind: "public"` with the
 *     session behind it (`invoke.agents.add`) — who may actually call it
 *     is its range (5.2 开放范围, P4-03), open to all contacts by default
 *     (the first call raises a card);
 *   - the A2A directory lists it (`a2a.directory.add`), and P4-05's
 *     executor (AskAct) runs its tasks (问 on a read-only branch, 办 on the
 *     main line behind the owner's turn);
 *   - the bypass policy counts it as reachable (`bypassPolicy`'s
 *     `isPrivate` is false): its identity may not skip every confirmation.
 *
 * Refused: an archived session, a hidden 「只问」 branch or a resident's
 * session, an identity in bypass (409 `bypass_not_private`), and a harness
 * with no read-only mode while 办 is off (5.7: it could answer nothing —
 * `act_required`).
 *
 * Taking it back (or deleting the session): the row goes; calls in
 * progress stop (`recheck` with the reason, then `forgetAgent`: grants,
 * range, cards; its listeners drop P4-05's 办 settings and end the A2A
 * tasks still open — queued turns withdrawn, running ones stopped, side
 * effects not rolled back).
 *
 * A PIN reset does not take public agents back (ADR-121 table:
 * `agent-exposure` revokes nothing — with every contact, grant, issuer
 * and device gone, nobody can call them; owner decision P4-02 #2).
 */
import type { Translate } from "../../../contracts/src/i18n.ts";
import { requestT } from "../app/language.ts";
import { ownerT } from "../platform/language.ts";
import type { FastifyInstance } from "fastify";
import type { Session } from "../../../contracts/src/index.ts";
import { api } from "../../../contracts/src/api/index.ts";
import { crossTalkNote, type SessionPublic } from "../../../contracts/src/api/invoke.ts";
import type { AppContext } from "../app/context.ts";
import { serve } from "../app/serve.ts";
import { HttpError } from "../app/errors.ts";
import type { Principal } from "../access/guard.ts";
import { commitLetIn } from "../access/let-in-commit.ts";
import { InvokeError, type AgentInfo, type InvokeAccess } from "../invoke/invoke-access.ts";
import type { AskAct } from "./ask-act.ts";

export class PublicAgents {
  constructor(
    private ctx: AppContext,
    private invoke: InvokeAccess,
    private askAct: AskAct,
  ) {
    // A session deleted (sessions.ts → forgetAgent): its row goes with it.
    invoke.onAgentGone((id) => void ctx.store.run("DELETE FROM public_agents WHERE session_id=?", id));
  }

  private row(sid: string): { since: number; by: string } | undefined {
    return this.ctx.store.one("SELECT since,by FROM public_agents WHERE session_id=?", sid);
  }
  /** Public now: a row, and a session that is still there. */
  isPublic(sid: string): boolean {
    const s = this.row(sid) ? this.ctx.store.session(sid) : undefined;
    return !!s && !s.deleting;
  }
  /** The directory (GET /a2a): every public agent; each shown only to callers its range lets see it. */
  ids(): string[] {
    return this.ctx.store
      .all("SELECT session_id FROM public_agents ORDER BY since")
      .map((r) => r.session_id as string)
      .filter((id) => this.isPublic(id));
  }
  /** The call authorization's resolver for public sessions (asked before the private fallback). */
  readonly resolve = (agentId: string): AgentInfo | null => {
    if (!this.row(agentId)) return null;
    const s = this.ctx.store.session(agentId);
    if (!s || s.deleting) return null;
    return { id: s.id, kind: "public", name: s.title || s.id, sessionId: s.id };
  };

  /** Why `s` cannot be made public now (null: it can). */
  private blocked(s: Session, t: Translate = ownerT()): { code: string; message: string } | null {
    if (s.archived) return { code: "session_archived", message: t("server-a2a.public.archived") };
    // P4-07: a resident agent's dedicated session (`residentOf`) is a
    // visitor's own conversation — never made public on its own.
    if (s.sidecar || s.kind === "resident" || s.residentOf)
      return { code: "not_publishable", message: t("server-a2a.public.notPublishable") };
    const p = this.ctx.store.one("SELECT data FROM profiles WHERE id=?", s.profileId);
    if (p)
      try {
        this.ctx.bypass?.checkOpen(JSON.parse(p.data));
      } catch (e: any) {
        return { code: e?.code ?? "bypass_not_private", message: String(e?.message ?? e) };
      }
    const v = this.askAct.view(s.id);
    if (v.ask.readOnly === "none" && !v.act)
      return {
        code: "act_required",
        message: t("server-a2a.public.actRequired", { why: v.ask.why ?? t("server-a2a.public.noReadOnly") }),
      };
    return null;
  }

  /** `t`: the language of its texts (the request's; the owner's otherwise). */
  view(s: Session, t: Translate = ownerT()): SessionPublic {
    const r = this.isPublic(s.id) ? this.row(s.id) : undefined;
    const v = this.askAct.view(s.id);
    return {
      sessionId: s.id,
      public: !!r,
      since: r?.since ?? null,
      act: v.act,
      ask: v.ask,
      blocked: r ? null : (this.blocked(s, t)?.message ?? null),
      crossTalk: crossTalkNote(t),
    };
  }

  /**
   * Make `s` public or take it back. Synchronous (inside `commitLetIn`).
   * Doing what is already so changes nothing.
   */
  set(s: Session, pub: boolean, by: string, t: Translate = ownerT()): SessionPublic & { stopped: number } {
    const store = this.ctx.store;
    const was = this.isPublic(s.id);
    if (pub === was) return { ...this.view(s, t), stopped: 0 };
    if (pub) {
      const no = this.blocked(s, t);
      if (no) throw new HttpError(409, no.message, no.code);
      store.atomic(() => {
        store.run("INSERT INTO public_agents(session_id,since,by) VALUES(?,?,?)", s.id, Date.now(), by);
        store.audit(by, "agent.public", JSON.stringify({ agent: s.id, public: true }), { object: `agent:${s.id}` });
      });
      return { ...this.view(s, t), stopped: 0 };
    }
    store.atomic(() => {
      store.run("DELETE FROM public_agents WHERE session_id=?", s.id);
      store.audit(by, "agent.private", JSON.stringify({ agent: s.id, public: false }), { object: `agent:${s.id}` });
    });
    // Private now: calls in progress no longer get in — stopped with this
    // reason; then everything kept for the agent goes (forgetAgent and its
    // listeners: grants, range, cards, 办 settings, open A2A tasks).
    const why = { code: "agent_private" as const, message: ownerT()("server-a2a.public.madePrivate") };
    let stopped = this.invoke.recheck({ agentId: s.id }, why);
    stopped += this.invoke.forgetAgent(s.id);
    return { ...this.view(s, t), stopped };
  }
}

/**
 * `GET /api/sessions/:id/public` (the owner's own session, no PIN) and
 * `PUT /api/sessions/:id/public` (`letsIn: "agent-exposure"`: `daisy:grant`
 * + PIN, written inside `commitLetIn`, ADR-121 §4a).
 */
export function registerPublicAgentRoutes(app: FastifyInstance, ctx: AppContext, pub: PublicAgents): void {
  const actor = (req: any) => (req.daisyPrincipal as Principal | undefined)?.label ?? "anonymous";
  serve(app, api.sessions.publicShow, async (req: any) => pub.view(ctx.session(req, String(req.params.id)), requestT(req)));
  serve(app, api.invoke.publicSet, async (req: any) => {
    const b = api.invoke.publicSet.body.parse(req.body ?? {});
    return commitLetIn(req, () => {
      try {
        return pub.set(ctx.session(req, String(req.params.id)), b.public, actor(req), requestT(req));
      } catch (e) {
        if (e instanceof InvokeError) throw e.toHttp();
        throw e;
      }
    });
  });
}
