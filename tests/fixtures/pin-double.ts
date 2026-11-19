/**
 * P1-03 tests: a stand-in for P1-05's PinService (packages/daisy/src/
 * access/pin.ts), same shape as access/pin-seam.ts. `grant(pin, holder)` hands
 * out a grant bound to `holder` when the PIN is right; `check` accepts
 * only a grant it handed out, for the same holder; `consume` uses one up.
 */
import { randomBytes } from "node:crypto";
import type { PinService } from "../../packages/daisy/src/access/pin-seam.ts";

export function pinDouble(
  pin = "246810",
): PinService & { grants: Map<string, string | undefined> } {
  let current: string | null = pin;
  const grants = new Map<string, string | undefined>();
  const hooks: (() => void)[] = [];
  let epoch = 0;
  return {
    grants,
    status: () => ({ set: current !== null, lockedUntil: null }),
    set(newPin, oldPin) {
      if (current !== null && oldPin !== current) throw Error("wrong PIN");
      current = newPin;
      epoch++;
    },
    grant(p, holder) {
      if (current === null || p !== current) throw Error("wrong PIN");
      const g = randomBytes(16).toString("base64url");
      grants.set(g, holder);
      return { grant: g, expiresAt: Date.now() + 300_000 };
    },
    check: (g, holder) => !!g && grants.has(g) && grants.get(g) === holder,
    consume: (g, holder) => grants.has(g) && grants.get(g) === holder && grants.delete(g),
    resetLocal() {
      epoch++;
      current = null;
      grants.clear();
      for (const f of hooks) f();
    },
    onReset: (f) => void hooks.push(f),
    epoch: () => epoch,
  };
}
