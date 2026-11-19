/**
 * bypassPermissions (2026-11-03): an AI that
 * others can find or call — public, 指定人, on the owner's allowlist, with a
 * pair grant — never runs without the harness's own permission prompts:
 * no Claude Code bypassPermissions, no Codex danger-full-access with
 * approval policy never (nor Kimi yolo). Only a private AI may — and
 * never a resident (an AI that may be found or called must never run
 * without the prompts). Enforced
 * when an identity is saved, when a conversation is created, made
 * visible or switches identity, and when a turn is handed to a Runner;
 * at start, identities that break it go back to the default mode and
 * their owner is told.
 */
import type { Store } from "../store/index.ts";
import type { notificationWriter } from "../sessions/notifications.ts";
import {
  bypassMode,
  type Session,
} from "../../../contracts/src/index.ts";

import { LocalizedError } from "../app/errors.ts";
import { ownerT } from "../platform/language.ts";

/** A turn its owner started herself (see forLaunch). No job: a launch for her. */
export function ownerTurn(job?: {
  request_id?: string;
  origin?: string | null;
}): boolean {
  if (!job) return true;
  const r = String(job.request_id || "");
  if (job.origin === "agent") return true;
  if (job.origin === "schedule")
    return r.startsWith("schedule:") && !/^schedule:callback(-human)?:/.test(r);
  if (/^(op|understanding):/.test(r)) return true;
  if (/^owner-approval:/.test(r)) return !r.endsWith(":expired");
  // Her own message (any id she chose); every Daisy-made id has a prefix.
  return !/^[a-z][a-z-]*:/.test(r);
}
export function bypassPolicy(
  store: Store,
  d: {
    /** Private on the current rules: only its owner can find or call it. */
    isPrivate: (s: Session) => boolean;
    /** The notification writer. */
    notifications: ReturnType<typeof notificationWriter>;
    /** Take a session's online process offline (live.stop). */
    stop?: (sid: string) => void;
  },
) {
  /** The live conversations on identity `pid` that others can reach. */
  function exposed(pid: string): Session[] {
    return store
      .all(
        "SELECT id FROM sessions WHERE json_extract(data,'$.profileId')=? AND COALESCE(json_extract(data,'$.deleting'),0)=0",
        pid,
      )
      .map((r) => store.session(r.id))
      .filter((s): s is Session => !!s && !s.deleting && reachable(s));
  }
  /**
   * Others can find or trigger it: not private, or a resident. (P1-01: a
   * private AI in a 群聊 with others counted too; 群聊 is gone.)
   */
  function reachable(s: Session): boolean {
    // P4-07: a resident agent's dedicated session is reachable by its visitor.
    return s.kind === "resident" || !!s.residentOf || !d.isPrivate(s);
  }
  /** An identity being saved with these settings. */
  function checkProfile(pid: string, p: any) {
    if (!bypassMode(p)) return;
    const open = exposed(pid);
    if (open.length)
      throw new LocalizedError(
        409,
        "bypass_not_private",
        open.length > 1 ? "server-approvals.bypass.exposedMany" : "server-approvals.bypass.exposedOne",
        { title: open[0]!.title, n: open.length },
      );
  }
  /** A conversation on identity `p` becoming reachable by others. */
  function checkOpen(p: any, resident = false) {
    if (bypassMode(p))
      throw new LocalizedError(
        409,
        "bypass_not_private",
        resident ? "server-approvals.bypass.resident" : "server-approvals.bypass.session",
      );
  }
  /**
   * What a Runner is told to launch with: never bypass for a reachable AI,
   * whatever the identity row says (an older control plane, a hand edit),
   * and only for a turn its owner started herself (review 2026-11-03: a
   * whitelist, not a list of the others): her message or command, her
   * 快速了解, her decision on its approval, its own timers and the turns
   * its process starts by itself. Everything else — event wakes,
   * plugin callbacks, an expired approval, the legacy-archive notice, any
   * request id Daisy does not know — launches without bypass.
   */
  function forLaunch(
    s: Session,
    profile: any,
    job?: { request_id?: string; origin?: string | null },
  ) {
    if (!bypassMode(profile) || (ownerTurn(job) && !reachable(s)))
      return profile;
    const out = { ...profile };
    delete out.permissionMode;
    if (out.agent === "codex") delete out.sandboxMode;
    return out;
  }
  /**
   * At start (idempotent): identities in bypass that a reachable AI uses go
   * back to the agent's default mode — Claude Code's own, Codex
   * on-request in workspace-write, Kimi default — recorded and told to
   * their owner. Identities used only by private AIs are left alone.
   */
  function migrate() {
    for (const r of store.all("SELECT id,owner_id,data FROM profiles")) {
      let p: any;
      try {
        p = JSON.parse(r.data);
      } catch {
        continue;
      }
      if (!bypassMode(p)) continue;
      const open = exposed(r.id);
      if (!open.length) continue;
      const was = `${p.permissionMode || ""}${p.sandboxMode ? "/" + p.sandboxMode : ""}`;
      delete p.permissionMode;
      if (p.agent === "codex") delete p.sandboxMode;
      store.atomic(() => {
        store.run(
          "UPDATE profiles SET data=? WHERE id=?",
          JSON.stringify(p),
          r.id,
        );
        store.audit("system", "profile.bypass.downgrade", `${r.id}:${was}`);
        // Its processes still online run in the old mode: they end now.
        for (const x of store.all(
          "SELECT id FROM sessions WHERE json_extract(data,'$.profileId')=?",
          r.id,
        ))
          d.stop?.(x.id);
        // Information only (approvalState "notice"): kind approval, not
        // action required, nothing to retract.
        d.notifications.emit({
          userId: r.owner_id,
          key: `approval:notice:bypass:${r.id}:${Date.now()}:notice`,
          kind: "approval",
          title: ownerT()(
            open.length > 1 ? "server-approvals.bypass.downgradedMany" : "server-approvals.bypass.downgradedOne",
            { label: p.label || r.id, was, title: open[0]!.title, n: open.length },
          ),
          subject: `notice:bypass:${r.id}`,
          notificationId: `approval:notice:bypass:${r.id}`,
        });
      });
    }
  }
  return {
    checkProfile,
    checkOpen,
    forLaunch,
    migrate,
    exposed,
    reachable,
    ownerTurn,
  };
}
