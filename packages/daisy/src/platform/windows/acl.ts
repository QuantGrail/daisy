/**
 * P5-05 (ADR-141): "only the owner can read it" on Windows — the ACL
 * counterpart of 0700 / 0600 (S-3).
 *
 * Owner-only here means what OpenSSH for Windows requires of a private key:
 * the security descriptor's DACL lets only this account, SYSTEM and the
 * Administrators group in (on POSIX root can always read too). Setting it
 * (`acl-set`, the helper): a protected DACL — nothing inherited from the
 * parent — with full control for those three, inheritable on a folder so
 * whatever Daisy creates inside gets the same. Checking it (`acl-get`): the
 * entries, every SID in full, are judged here by a pure function, so the
 * rule is tested everywhere.
 *
 * Without the helper (no C# compiler, policy blocks it) nothing is changed
 * and the check answers null ("cannot tell"), as before P5-05.
 */
import { log } from "../../observe/log.ts";
import { HelperUnavailable, runHelper } from "./helper.ts";

const SYSTEM = "S-1-5-18";
const ADMINS = "S-1-5-32-544";
const CREATOR_OWNER = "S-1-3-0";
/** PropagationFlags.InheritOnly: the entry applies to what is created inside, not here. */
const INHERIT_ONLY = 2;

export interface AclEntry {
  allow: boolean;
  inherited: boolean;
  inheritance: number;
  propagation: number;
  rights: number;
  sid: string;
}
export interface Acl {
  user: string;
  owner: string | null;
  protectedDacl: boolean;
  entries: AclEntry[];
}

/**
 * The helper's `acl-get` (every SID in full — SDDL abbreviates some, e.g.
 * `LA` for an account whose RID is 500, so a check on SDDL text would not
 * recognise this very account): this user, `O <owner>`, `P <0|1>`, then
 * `A|D <inherited> <inheritance> <propagation> <rights> <SID>` per entry.
 */
export function parseAcl(text: string): Acl {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const acl: Acl = { user: lines[0] ?? "", owner: null, protectedDacl: false, entries: [] };
  for (const l of lines.slice(1)) {
    const w = l.split(" ");
    if (w[0] === "O") acl.owner = w[1] && w[1] !== "-" ? w[1] : null;
    else if (w[0] === "P") acl.protectedDacl = w[1] === "1";
    else if ((w[0] === "A" || w[0] === "D") && w.length >= 6)
      acl.entries.push({
        allow: w[0] === "A",
        inherited: w[1] === "1",
        inheritance: Number(w[2]),
        propagation: Number(w[3]),
        rights: Number(w[4]),
        sid: w[5]!,
      });
  }
  return acl;
}

/**
 * Whether only this account, SYSTEM and Administrators are let in, and one
 * of them owns it. Deny entries let no one in; an allow entry for anyone
 * else (Users, Authenticated Users, Everyone, another account) makes it
 * loose. CREATOR OWNER, inherit-only, is fine (it becomes the creator —
 * this account — on what is created inside).
 */
export function ownerOnlyAcl(acl: Acl): boolean {
  const same = (a: string, b: string) => a.toUpperCase() === b.toUpperCase();
  const trusted = (sid: string) => !!acl.user && (same(sid, acl.user) || same(sid, SYSTEM) || same(sid, ADMINS));
  if (!acl.owner || !trusted(acl.owner)) return false;
  for (const e of acl.entries) {
    if (!e.allow || trusted(e.sid)) continue;
    if (same(e.sid, CREATOR_OWNER) && (e.propagation & INHERIT_ONLY) !== 0) continue;
    return false;
  }
  return true;
}

let warned = false;
const unavailable = (e: unknown) => {
  if (!(e instanceof HelperUnavailable)) throw e;
  if (!warned) {
    warned = true;
    log.warn(`cannot set / check owner-only permissions on Windows (${e.message}); a data directory under your user folder is by default reachable only by you, SYSTEM and administrators`);
  }
};

/** Make `path` owner-only (true), or false when the helper is not there. */
export function setOwnerOnly(path: string): boolean {
  try {
    runHelper(["acl-set", path]);
    return true;
  } catch (e) {
    unavailable(e);
    return false;
  }
}

/** Whether `path` is owner-only; null when it cannot be told. */
export function isOwnerOnly(path: string): boolean | null {
  try {
    return ownerOnlyAcl(parseAcl(runHelper(["acl-get", path])));
  } catch (e) {
    unavailable(e);
    return null;
  }
}
