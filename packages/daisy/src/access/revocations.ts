/**
 * P4-02 (5.11 「PIN 码」, T-9, ADR-121): what a PIN reset takes back.
 *
 * Resetting the PIN (on this machine only) revokes every outward grant,
 * every mutually recognised card, every paired device, the external
 * issuer, the tokens fetched for an AI — so whoever got round to resetting
 * it gains no permission that was standing, and the owner sees it
 * happened (D-36's notice, the audit row written here).
 *
 * Each store that holds such a permission registers a hook for its kind
 * (contracts let-in.ts `REVOCATIONS`). The hooks run inside the reset's
 * transaction (PinService.resetLocal → onReset): a hook that throws undoes
 * the reset's database part. Hooks on the database run first; hooks with
 * effects outside it (files, memory: `outside: true`) run last, so a
 * refusal by a database hook leaves them untouched. Outside hooks cannot
 * be undone: when one of them throws after others already ran, those are
 * named in `failure()` and the reset route writes a `pin.reset.partial`
 * audit row outside the (rolled back) transaction (review L-1). An
 * outside hook removes its files before it forgets in memory, so a
 * failure leaves memory no more trusting than disk. A hook is
 * synchronous: one that returns a thenable is refused (review L-2). A
 * kind nobody registered yet (its package has not landed) is recorded as
 * `pending` in the audit row.
 *
 * Who registers what (ADR-121 §4):
 *   issuer          access/index.ts (P2-01)        outside
 *   ui-origins      access/index.ts (P2-04)        outside
 *   external-face   access/index.ts (review H-1)   outside
 *   ai-tokens       access/index.ts (P2-02); P4-08 adds its cross-Daisy tokens
 *   contacts        P4-01
 *   invoke-grants   P4-03 (grants, allowlist, named lists, pending cards)
 *   devices         P5-03
 *   visitor-tokens  access/visitor-tokens.ts (P4-12, `daisy token`)
 */
import { ownerT } from "../platform/language.ts";
import {
  REVOCATION_KINDS,
  type RevocationKind,
} from "../../../contracts/src/index.ts";

/**
 * One store's revocation: take back everything of its kind, return how
 * many there were (for the audit; `void` when it cannot tell).
 */
export type RevokeHook = () => number | void;

export interface RevocationSummary {
  /** Per kind: how many were taken back (null: its hook did not say). */
  revoked: Partial<Record<RevocationKind, number | null>>;
  /** Kinds nobody registered a hook for yet (their package has not landed). */
  pending: RevocationKind[];
}

interface Entry {
  kind: RevocationKind;
  name: string;
  fn: RevokeHook;
  outside: boolean;
}

/** A reset that failed after outside hooks had already run (review L-1). */
export interface RevocationFailure {
  failed: RevocationKind;
  /** Outside kinds whose hooks finished before the failure: not undone. */
  outsideDone: RevocationKind[];
}

export class Revocations {
  private entries: Entry[] = [];
  private lastFailure: RevocationFailure | null = null;

  /** The last run's failure, once (the reset route audits it). */
  failure(): RevocationFailure | null {
    const f = this.lastFailure;
    this.lastFailure = null;
    return f;
  }

  /**
   * Register `fn` for `kind`. `name`: who it is (for errors and tests).
   * `outside`: its effect is outside the database (files, memory) — it
   * runs after every database hook.
   */
  register(
    kind: RevocationKind,
    name: string,
    fn: RevokeHook,
    o: { outside?: boolean } = {},
  ): void {
    if (!REVOCATION_KINDS.includes(kind))
      throw new TypeError(`unknown revocation kind ${String(kind)}`);
    this.entries.push({ kind, name, fn, outside: !!o.outside });
  }

  /** The kinds that have at least one hook. */
  registered(): RevocationKind[] {
    return REVOCATION_KINDS.filter((k) => this.entries.some((e) => e.kind === k));
  }

  /** Who registered for `kind` (tests, the ADR's table). */
  namesOf(kind: RevocationKind): string[] {
    return this.entries.filter((e) => e.kind === kind).map((e) => e.name);
  }

  /**
   * Run every hook: database ones first, then the outside ones, each group
   * in the order registered. A throw stops here (and, inside the reset's
   * transaction, undoes its database part; `failure()` names the outside
   * kinds already taken back).
   */
  runAll(): RevocationSummary {
    const revoked: RevocationSummary["revoked"] = {};
    const order = [
      ...this.entries.filter((e) => !e.outside),
      ...this.entries.filter((e) => e.outside),
    ];
    this.lastFailure = null;
    const outsideDone: RevocationKind[] = [];
    for (const e of order) {
      let n: unknown;
      try {
        n = e.fn();
        if (n !== null && typeof n === "object" && typeof (n as { then?: unknown }).then === "function")
          throw new Error("a revocation hook must be synchronous (it returned a Promise)");
      } catch (err) {
        const done = [...new Set(outsideDone)];
        this.lastFailure = { failed: e.kind, outsideDone: done };
        const t = ownerT();
        throw new Error(
          t("server-access.revoke.failed", {
            kind: e.kind,
            name: e.name,
            done: done.length ? t("server-access.revoke.alreadyDone", { kinds: done.join(t("server-access.revoke.listSeparator")) }) : "",
            error: String((err as Error)?.message ?? err),
          }),
        );
      }
      if (e.outside) outsideDone.push(e.kind);
      const before = revoked[e.kind];
      const count = typeof n === "number" && Number.isFinite(n) ? n : null;
      revoked[e.kind] =
        before === undefined ? count : before === null || count === null ? null : before + count;
    }
    return {
      revoked,
      pending: REVOCATION_KINDS.filter((k) => !(k in revoked)),
    };
  }
}
