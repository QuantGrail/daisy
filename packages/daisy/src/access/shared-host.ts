/**
 * P1-03 (D-09, W-2): is this a machine other people log in to? The
 * passcode's `auto` mode turns on when it is. A browser cannot prove which
 * system account it runs under, so on a shared machine only the one-time
 * code (`daisy open`, readable through the 0600 command-line credential)
 * tells the owner apart from the other accounts.
 *
 * Fails closed: whenever the answer cannot be had, the machine counts as
 * shared.
 *
 * - Linux: `getent passwd` (also LDAP / SSSD accounts when enumerable),
 *   else /etc/passwd: another account with uid ≥ UID_MIN (login.defs,
 *   default 1000), not nobody, with a login shell. Plus: a process of
 *   another such uid running now (/proc), which catches directory
 *   accounts that do not enumerate.
 * - macOS: `dscl . -list /Users UniqueID`: another uid ≥ 501 whose name
 *   does not start with `_`. Plus (P5-04, like Linux's /proc look): a
 *   process of another uid ≥ 501 running now (`ps -axo uid=`), which
 *   catches directory (network / mobile) accounts the local node does not
 *   list.
 * - Windows (P5-05): the user profiles registered on this machine (the
 *   helper's `profiles`, HKLM ProfileList): another local, domain or
 *   Microsoft Entra account's profile (S-1-5-21-…-RID ≥ 1000, S-1-12-1-…)
 *   than this one. No helper: shared.
 * - Anything else: shared.
 */
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { systemUid } from "./ports.ts";
import { runHelper } from "../platform/windows/helper.ts";

/** The profile SIDs (one per line) of people other than `me` (Windows). */
export function otherWindowsProfiles(list: string, me: string): string[] {
  return list
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((sid) => sid && sid.toUpperCase() !== me.toUpperCase())
    .filter((sid) => {
      if (/^S-1-12-1-/i.test(sid)) return true;
      const m = /^S-1-5-21-\d+-\d+-\d+-(\d+)$/i.exec(sid);
      return !!m && Number(m[1]) >= 1000;
    });
}

const NO_LOGIN = /(nologin|false|sync|shutdown|halt)$/;

export function otherAccountsInPasswd(
  passwd: string,
  me: number,
  uidMin: number,
): string[] {
  const out: string[] = [];
  for (const line of passwd.split("\n")) {
    const f = line.split(":");
    if (f.length < 7) continue;
    const uid = Number(f[2]);
    if (!Number.isInteger(uid) || uid < uidMin || uid === me) continue;
    if (uid === 65534 || f[0] === "nobody") continue;
    if (!f[6] || NO_LOGIN.test(f[6].trim())) continue;
    out.push(f[0]!);
  }
  return out;
}

export function otherAccountsInDscl(list: string, me: number): string[] {
  const out: string[] = [];
  for (const line of list.split("\n")) {
    const [name, id] = line.trim().split(/\s+/);
    const uid = Number(id);
    if (!name || name.startsWith("_") || !Number.isInteger(uid)) continue;
    if (uid < 501 || uid === me || name === "nobody") continue;
    out.push(name);
  }
  return out;
}

function linuxUidMin(): number {
  try {
    const m = /^\s*UID_MIN\s+(\d+)/m.exec(readFileSync("/etc/login.defs", "utf8"));
    if (m) return Number(m[1]);
  } catch {}
  return 1000;
}

function linuxProcessOfOther(me: number, uidMin: number): boolean {
  for (const pid of readdirSync("/proc")) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      const uid = statSync(`/proc/${pid}`).uid;
      if (uid >= uidMin && uid !== me && uid !== 65534) return true;
    } catch {}
  }
  return false;
}

/** `ps -axo uid=` output (macOS): a process of another account ≥ 501 runs. */
export function otherUidRunning(psUids: string, me: number, uidMin = 501): boolean {
  return psUids
    .split("\n")
    .map((l) => Number(l.trim()))
    .some((uid) => Number.isInteger(uid) && uid >= uidMin && uid !== me);
}

let cached: { at: number; shared: boolean } | undefined;

export function sharedHost(
  platform: NodeJS.Platform = process.platform,
  me: number = systemUid(),
): boolean {
  if (cached && Date.now() - cached.at < 60_000 && platform === process.platform)
    return cached.shared;
  let shared = true;
  try {
    if (platform === "linux") {
      const uidMin = linuxUidMin();
      const r = spawnSync("getent", ["passwd"], { encoding: "utf8", timeout: 3000 });
      const passwd =
        r.status === 0 && r.stdout ? r.stdout : readFileSync("/etc/passwd", "utf8");
      shared =
        otherAccountsInPasswd(passwd, me, uidMin).length > 0 ||
        linuxProcessOfOther(me, uidMin);
    } else if (platform === "win32") {
      const me = runHelper(["whoami"]).trim();
      shared = !me || otherWindowsProfiles(runHelper(["profiles"]), me).length > 0;
    } else if (platform === "darwin") {
      const r = spawnSync("dscl", [".", "-list", "/Users", "UniqueID"], {
        encoding: "utf8",
        timeout: 3000,
      });
      shared = r.status !== 0 || otherAccountsInDscl(r.stdout || "", me).length > 0;
      if (!shared) {
        const p = spawnSync("ps", ["-axo", "uid="], { encoding: "utf8", timeout: 3000 });
        shared = p.status !== 0 || otherUidRunning(p.stdout || "", me);
      }
    }
  } catch {
    shared = true;
  }
  if (platform === process.platform) cached = { at: Date.now(), shared };
  return shared;
}
