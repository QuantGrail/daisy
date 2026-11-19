/**
 * P4-02 review M-1 (ADR-121 §4a): a 「放别人进来」 request persists only
 * under the PIN it was let through with.
 *
 * The guard checks the PIN grant once, when the request arrives. A
 * handler that then waits (fetching an issuer's keys, importing a card,
 * reaching another Daisy) could otherwise finish after the PIN was reset
 * — and write back the very trust the reset took away. So the guard
 * notes the PIN's epoch (PinService.epoch: changes on every set, change
 * and reset) when the grant passes, and every handler of such a route
 * persists inside `commitLetIn(req, () => …)`: the epoch is checked again,
 * synchronously, right before the write. A changed epoch → 409
 * `pin_changed`, nothing written.
 *
 * Rules for the handlers (P4-01's card import, P4-03's grants, …):
 * - do every `await` before `commitLetIn`; the function given to it is
 *   synchronous (a thenable it returns is refused) and does all the
 *   persisting — database rows, files, in-memory state;
 * - `serve` checks that a successful answer of a PIN route went through
 *   `commitLetIn` (a route that forgot fails its tests with a 500).
 */
import { LocalizedError } from "../app/errors.ts";
import type { PinService } from "./pin-seam.ts";

/** What the guard leaves on a request whose PIN grant passed. */
export interface LetInSeal {
  /** Is the PIN still what it was when the grant passed? */
  still(): boolean;
}

/** The guard: seal a request whose PIN grant just passed. */
export function sealLetIn(req: any, pin: PinService): void {
  const epoch = typeof pin.epoch === "function" ? pin.epoch() : undefined;
  const seal: LetInSeal = {
    still: () => epoch !== undefined && typeof pin.epoch === "function" && pin.epoch() === epoch,
  };
  req.daisyLetInSeal = seal;
}

export const PIN_CHANGED_CODE = "pin_changed";

/**
 * Persist a 「放别人进来」 change — only if the PIN is still the one its
 * grant was checked under. `fn` must be synchronous.
 */
export function commitLetIn<T>(req: any, fn: () => T): T {
  const seal = req?.daisyLetInSeal as LetInSeal | undefined;
  if (!seal || !seal.still())
    throw new LocalizedError(409, PIN_CHANGED_CODE, "server-access.letIn.pinChanged");
  const out = fn();
  if (out && typeof (out as any).then === "function")
    throw new Error("commitLetIn: the write must be synchronous (await first, then commit)");
  req.daisyLetInCommitted = true;
  return out;
}
