/**
 * P1-03 ↔ P1-05: what the guard asks of the PIN (5.11 「PIN 码」,
 * local-api.md §6). P1-05 implements it in packages/daisy/src/access/pin.ts;
 * createApp takes it as `opts.pin`. Without one, every route marked
 * `pin: true` is refused — failing closed (ADR-110).
 */
export interface PinService {
  status(): { set: boolean; lockedUntil: number | null };
  set(newPin: string, oldPin?: string): void;
  /** `holder`: the credential that asked (local-api.md §6.3); `check` then wants the same. */
  grant(pin: string, holder?: string): { grant: string; expiresAt: number };
  check(grant: string | undefined, holder?: string): boolean;
  /**
   * Use a grant up (review M-3): true when it was live for `holder`, and
   * from now on it is not. The guard calls it for the command line, whose
   * holder is the fixed name "cli" shared by every command-line process —
   * the owner's terminal and the AI's alike — so a grant the owner's
   * `daisy` command took is good for its one request only. Until P1-05's
   * PinService has it, the command line's PIN routes are refused.
   */
  consume?(grant: string, holder?: string): boolean;
  resetLocal(): void;
  /**
   * P4-02 review M-1: a number that changes whenever the PIN is set,
   * changed or reset. The guard notes it when a PIN grant passes; a
   * 「放别人进来」 handler checks it is unchanged right before it persists
   * (access/let-in-commit.ts). Without it, such handlers refuse.
   */
  epoch?(): number;
  onReset(fn: () => void): void;
}
/** The request header that carries a PIN grant (local-api.md §6). */
export const PIN_GRANT_HEADER = "daisy-pin-grant";
