import { readFileSync } from "node:fs";
import { takeNativeApprovals } from "../approvals/native-approvals.ts";
import { sessionAutoCompact } from "../sessions/auto-compact.ts";
import type {
  RunnerJob,
  Session,
} from "../../../contracts/src/index.ts";
import { askOnlyRoute } from "../../../contracts/src/agent-capabilities.ts";
import { jobToolsField } from "../../../contracts/src/native-tools.ts";
import { localTimeZone, zoneName } from "../../../contracts/src/scheduler.ts";
import { bypassMode } from "../../../contracts/src/approvals.ts";
import { permissionModes } from "../../../contracts/src/acp-harnesses.ts";
import type { AppBase, LateServices } from "./context.ts";
import type { ProfileHelpers } from "./profiles.ts";
import { residentLimitsOf } from "../resident/config.ts";
import { inSessionT } from "../platform/language.ts";
import { nameFor } from "../platform/default-names.ts";
/** What a Runner gets for a leased job (P1-00: moved from app.ts). */
export function jobPayloadHelpers(
  ctx: AppBase & LateServices & ProfileHelpers,
) {
  const { store, profileView } = ctx;
  /**
   * after 「换身份」, where the Agent's transcript still is — the
   * previous identity's config directory, when that identity is still on
   * this conversation's node and its directory differs.
   */
  function carryFrom(s: Session, pr: any): Pick<RunnerJob, "carryFrom"> {
    if (!s.identityMove || s.agent !== "claude") return {};
    const old = store.one(
      "SELECT node_id,data FROM profiles WHERE id=?",
      s.identityMove.from,
    );
    if (!old || old.node_id !== s.nodeId) return {};
    const from = String(JSON.parse(old.data).configDir || ""),
      to = String(JSON.parse(pr.data).configDir || "");
    return from === to
      ? {}
      : { carryFrom: { profileId: s.identityMove.from, configDir: from } };
  }
  /** What the node's Runner declared ({} when unreadable). */
  function nodeCaps(nodeId: string): any {
    try {
      return JSON.parse(
        store.one("SELECT capabilities FROM nodes WHERE id=?", nodeId)
          ?.capabilities || "{}",
      );
    } catch {
      return {};
    }
  }
  /**
   * ADR-154: Daisy's tools for a job of `s`, by the names its
   * conversation knows and its Runner serves (`jobToolsField`; the
   * control plane's text names them the same way, `toolNamesFor`).
   */
  const toolsField = (s: Session) => jobToolsField(s, nodeCaps(s.nodeId));
  /** the node's Runner said it runs 「只问」 sidecars. */
  function runsSidecars(nodeId: string) {
    try {
      return (
        JSON.parse(
          store.one("SELECT capabilities FROM nodes WHERE id=?", nodeId)
            ?.capabilities || "{}",
        )?.askSidecar?.version >= 1
      );
    } catch {
      return false;
    }
  }
  /** What a runner gets for a leased job (claim, or an Agent-started turn). */
  function jobPayload(job: any): RunnerJob {
    // Kept background reports go with the turn
    // being claimed (both claim paths come through here).
    job = ctx.scheduler.claimReports(job);
    // 「只问」 sidecar summaries ride the same turn.
    job = ctx.sidecars.carry(job);
    const s = store.session(job.session_id)!,
      pr = store.one("SELECT * FROM profiles WHERE id=?", s.profileId),
      w = store.one("SELECT * FROM workspaces WHERE id=?", s.workspaceId);
    // P6-28: Daisy's own names (the identity's, the workspace's) in the
    // session's language — the turn writes them into its items (quota).
    const st = inSessionT(s);
    const profile = profileView(pr, st);
    // this conversation's own model / effort win over the identity's.
    if (s.settings?.model) profile.model = s.settings.model;
    if (s.settings?.reasoningEffort)
      profile.reasoningEffort = s.settings.reasoningEffort;
    if (s.settings?.serviceTier) profile.serviceTier = s.settings.serviceTier;
    // a resident's own auto-compact threshold wins over the identity's.
    if (s.resident) {
      const t = sessionAutoCompact(
        s,
        typeof profile.autoCompactTokens === "number" &&
          profile.autoCompactTokens > 0
          ? profile.autoCompactTokens
          : null,
      );
      if (t === null) delete profile.autoCompactTokens;
      else profile.autoCompactTokens = t;
    }
    // a read-only sidecar gets no Daisy tools.
    const sidecar = !!s.sidecar;
    // the owner's native 「允许并重试」 (Codex), with her turns only.
    const nativeApprovals = sidecar
      ? undefined
      : takeNativeApprovals(store, job);
    // what the Runner needs to answer natively — the main
    // session's current native id, the earlier questions, how this node's
    // agent answers; and the main session's effective model / effort (a
    // Codex fork does not inherit the thread's model).
    // ADR-154: a resident's built-in prompt names the zone its cron
    // expressions are read in — this control plane's, also when its Runner
    // is on another machine and writes the text itself.
    let session: Session = s.resident
      ? { ...s, resident: { ...s.resident, timeZone: zoneName(localTimeZone()) } }
      : s;
    if (s.sidecar) {
      const main = store.session(s.sidecar.parent);
      let caps: any = {};
      try {
        caps = JSON.parse(
          store.one("SELECT capabilities FROM nodes WHERE id=?", s.nodeId)
            ?.capabilities || "{}",
        );
      } catch {}
      const route = askOnlyRoute(caps, s.agent);
      session = {
        ...s,
        sidecar: {
          ...s.sidecar,
          mainNativeId: main?.nativeId ?? s.sidecar.forkFrom,
          history: ctx.sidecars.history(s.id),
          ...(route
            ? { native: { sideQuestion: route.sideQuestion, fork: route.fork } }
            : {}),
        },
      };
      const model =
        main?.settings?.model ||
        (s.agent === "codex" ? main?.runtime?.model : "") ||
        "";
      const effort =
        main?.settings?.reasoningEffort ||
        (s.agent === "codex" ? main?.runtime?.effort : "") ||
        "";
      if (model) profile.model = model;
      if (effort) profile.reasoningEffort = effort;
    }
    // P4-05 (ADR-124): a turn an A2A task started runs with the permission
    // mode Daisy chose for it — the read-only mode for a 「问」 on the main
    // line, the owner's 办 setting for a 「办」.
    const a2aTurn = store.one(
      "SELECT kind,permission_mode FROM a2a_turns WHERE job_id=?",
      job.id,
    );
    if (a2aTurn?.permission_mode)
      profile.permissionMode = a2aTurn.permission_mode;
    const launchProfile = ctx.bypass
      ? ctx.bypass.forLaunch(s, profile, job)
      : profile;
    // an external task never runs in a mode that skips every
    // confirmation, whatever the identity says.
    if (a2aTurn && bypassMode({ ...launchProfile, agent: s.agent }))
      launchProfile.permissionMode = permissionModes(s.agent).default;
    // P4-07 (ADR-126): a resident agent's dedicated session — its tools,
    // directories, and whether what auto mode still asks about is declined.
    const residentLimits = s.residentOf ? residentLimitsOf(store, s.residentOf.agentId) : null;
    const guide = ctx.promptLayers.guideFor(s);
    return {
      id: job.id,
      // this control plane runs Daisy's scheduler.
      ...(sidecar ? {} : toolsField(s)),
      lease: job.lease,
      session,
      // the layered prompt, where it is on for this session and
      // its Runner takes it (otherwise absent: everything as before).
      ...(guide ? { guide } : {}),
      ...(residentLimits ? { residentLimits } : {}),
      text: job.preamble ? `${job.preamble}\n\n${job.text}` : job.text,
      ...(job.origin === "agent"
        ? { origin: "agent" as const, wake: job.wake || "" }
        : job.origin === "schedule"
          ? { origin: "schedule" as const, wake: job.wake || "" }
          : {}),
      ...(job.context ? { context: JSON.parse(job.context) } : {}),
      ...(job.terminal ? { terminal: JSON.parse(job.terminal) } : {}),
      ...(nativeApprovals ? { nativeApprovals } : {}),
      operation: (() => {
        const o = store.one(
          "SELECT data FROM job_operations WHERE job_id=?",
          job.id,
        );
        if (!o) return undefined;
        const action = JSON.parse(o.data);
        return action.encryptedArgs
          ? {
              name: action.name,
              args: JSON.parse(store.decrypt(action.encryptedArgs)),
            }
          : action;
      })(),
      profile: {
        // whatever the row says, a reachable AI never runs in bypass.
        ...launchProfile,
        apiKey: pr.secret ? store.decrypt(pr.secret) : undefined,
      },
      ...carryFrom(s, pr),
      workspace: {
        id: w.id,
        nodeId: w.node_id,
        label: nameFor("workspace", w.label, st),
        path: w.path,
      },
      attachments: JSON.parse(job.attachments).map((aid: string) => {
        const a = store.one("SELECT * FROM attachments WHERE id=?", aid);
        return {
          id: a.id,
          name: a.name,
          mime: a.mime,
          size: a.size,
          data: readFileSync(a.path).toString("base64"),
        };
      }),
    };
  }
  return { runsSidecars, jobPayload };
}
export type JobPayloadHelpers = ReturnType<typeof jobPayloadHelpers>;
