/**
 * P1-03 (D-01, 5.11): one Daisy, one owner — the system account that runs
 * it. There are no accounts and no roles: every row's `owner_id` is this
 * id, and a request that passed the guard (guard.ts) acts as the owner.
 */
import { userInfo } from "node:os";
import type { User } from "../../../contracts/src/index.ts";

export const OWNER_ID = "owner";

let name: string | undefined;
/** The owner as the API shows it (`username` = the system account). */
export function ownerUser(): User {
  if (name === undefined)
    try {
      name = userInfo().username;
    } catch {
      name = process.env.USER || process.env.USERNAME || "owner";
    }
  return { id: OWNER_ID, username: name };
}
