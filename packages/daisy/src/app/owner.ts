import type { User } from "../../../contracts/src/index.ts";
import { LocalizedError } from "./errors.ts";
import { ownerUser } from "../access/owner.ts";
import type { Principal } from "../access/guard.ts";
/**
 * P1-03 (D-01): who a request acts as. One Daisy has one owner; the guard
 * (access/guard.ts) has already decided whether the caller may make this
 * request at all, so a handler only asks for the owner. A request the
 * guard did not pass has no principal: refused (fail closed).
 */
export function ownerHelpers() {
  function user(req: any): User {
    if (!req?.daisyPrincipal)
      throw new LocalizedError(401, "unauthenticated", "server-app.auth.noCredential");
    return ownerUser();
  }
  const principal = (req: any): Principal | undefined => req?.daisyPrincipal;
  return { user, principal };
}
export type OwnerHelpers = ReturnType<typeof ownerHelpers>;
