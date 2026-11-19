/**
 * P4-03 (5.6 「可撤销。撤销时，对方还在进行中的调用会被停止」, T-5, ADR-122):
 * the calls others are making right now, so that taking a permission back
 * stops them.
 *
 * Whoever runs a call (P4-04's A2A server) registers it when it starts
 * executing — through `InvokeAccess.begin`, which checks again, at that
 * moment, that the caller is still let in (review M-1) — with a `stop`
 * that ends it (cancel the turn, fail the task), and ends the registration
 * when it finishes. The call authorization stops calls here when a grant is
 * revoked, the agent's range narrows, the whitelist changes, a contact is
 * removed or the PIN is reset. Memory only: a call does not outlive the
 * process (a restart interrupts it, 原则 2 — never replayed).
 */
import { randomUUID } from "node:crypto";
import { log } from "../observe/log.ts";

/** How a call was let in. `once`: a 仅本次 card (stands on its own, no grant behind it). */
export type CallVia = "whitelist" | "listed" | "grant" | "once";

/** Why a call is being stopped (said to the caller by whoever runs it). */
export interface StopReason {
  code: "grant_revoked" | "not_admitted" | "contact_removed" | "issuer_changed" | "agent_gone" | "agent_private" | "reset";
  message: string;
}

export interface ActiveCall {
  id: string;
  agentId: string;
  /** The person's grant key (InvokePerson.key). */
  person: string;
  contactId: string | null;
  /** The external issuer behind the person (null: a contact). */
  issuer: string | null;
  subject: string;
  via: CallVia;
  startedAt: number;
}

export interface CallHandle {
  readonly id: string;
  /** The call finished (or failed): forget it. Idempotent. */
  end(): void;
  /** Still registered (not ended, not stopped). */
  readonly active: boolean;
}

export interface CallFilter {
  agentId?: string;
  person?: string;
}

interface Entry extends ActiveCall {
  stop: (why: StopReason) => void;
}

export class Calls {
  private live = new Map<string, Entry>();

  /**
   * Register a call (InvokeAccess.begin only — it checks first). `stop` must end it (it is called at most
   * once, synchronously, from inside whatever change took the permission
   * back; it should not throw — a throw is logged and the call is
   * forgotten all the same).
   */
  add(c: Omit<ActiveCall, "id" | "startedAt"> & { stop: (why: StopReason) => void }): CallHandle {
    const id = randomUUID();
    this.live.set(id, { ...c, id, startedAt: Date.now() });
    const live = this.live;
    return {
      id,
      end: () => void live.delete(id),
      get active() {
        return live.has(id);
      },
    };
  }

  /** The calls in progress (matching `f`). */
  list(f: CallFilter = {}): ActiveCall[] {
    return [...this.live.values()]
      .filter((e) => match(e, f))
      .map(({ stop: _stop, ...rest }) => rest);
  }

  /** Stop the calls matching `f` (and `which`, when given). Returns how many. */
  stop(f: CallFilter, why: StopReason, which: (c: ActiveCall) => boolean = () => true): number {
    let n = 0;
    for (const e of [...this.live.values()]) {
      if (!match(e, f) || !which(e)) continue;
      this.live.delete(e.id);
      n++;
      try {
        e.stop(why);
      } catch (err) {
        log.warn("invoke: stopping a call failed", { call: e.id, why: why.code, error: String((err as Error)?.message ?? err) });
      }
    }
    return n;
  }

  get size(): number {
    return this.live.size;
  }
}

const match = (e: ActiveCall, f: CallFilter) =>
  (f.agentId === undefined || e.agentId === f.agentId) && (f.person === undefined || e.person === f.person);
