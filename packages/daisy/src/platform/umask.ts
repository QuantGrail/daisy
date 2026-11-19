/**
 * P6-15 (ADR-158, P5N-1): everything Daisy writes under its data directory
 * is owner-only. The process's file-creation mask is 077 from the first
 * line of every start (`daisy start`, launchd, systemd, a foreground run,
 * a successor started by its predecessor): new files 0600, new folders
 * 0700, whoever writes them inside the process (SQLite, plugins, the
 * Runner's caches, logs).
 *
 * The AI's tools are another matter (the dispatcher's decision, ADR-158):
 * a harness, a command, the terminal or a background job works in the
 * owner's own folders, so what it creates there follows the mask Daisy was
 * started with — exactly what it got before this change (the shell's under
 * `daisy start`; the launchd plist (launchd.ts, `Umask` 63) and the systemd
 * unit (autostart.ts, `UMask=0077`) already said 077). `spawnTree` starts
 * those programs under that mask (platform/spawn.ts); their homes under
 * the data directory are 0700 folders (their contents are not walked at
 * start, ADR-158 § review L3); the start tightens the rest.
 * Windows: no umask — the data directory's DACL is inherited.
 */
export const OWNER_UMASK = 0o077;
/**
 * The mask the first process of this start had, handed to the successor it
 * starts (update/guard.ts `startSuccessor`) and nowhere else: it is never
 * left in this process's environment, so no child sees it.
 */
export const START_UMASK_ENV = "DAISY_START_UMASK";

let start: number | null = null;

const parse = (v: string | undefined): number | null =>
  typeof v === "string" && /^0?[0-7]{3}$/.test(v) ? parseInt(v, 8) : null;
export const octal = (m: number) => m.toString(8).padStart(4, "0");
/** A mask that lets group or others write (000, 002, 020 …) is not handed to the AI's programs. */
export const groupOrOtherWritable = (m: number) => (m & 0o022) !== 0o022;

/**
 * The first thing a Daisy process does: mask 077, remembering the mask it
 * started with. `DAISY_START_UMASK` counts only for a successor (started by
 * its predecessor: `DAISY_RESPAWN_AFTER`) and is removed from the
 * environment either way. A mask that lets group or others write gets
 * those bits added back (`note` says so; main.ts prints it). Windows: null.
 */
export function ownerOnlyUmask(
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): { start: number; note?: string } | null {
  const carried = env.DAISY_RESPAWN_AFTER ? parse(env[START_UMASK_ENV]) : null;
  delete env[START_UMASK_ENV];
  if (platform === "win32") return null;
  const was = process.umask(OWNER_UMASK);
  let m = carried ?? was;
  let note: string | undefined;
  if (groupOrOtherWritable(m)) {
    note = `the file-creation mask at start, ${octal(m)}, lets the group or other accounts write; the AI's programs get ${octal(m | 0o022)} instead`;
    m |= 0o022;
  }
  start = m;
  return note ? { start: m, note } : { start: m };
}

/** What a successor's environment carries (empty when nothing was remembered). */
export function startUmaskEnv(): Record<string, string> {
  return start === null ? {} : { [START_UMASK_ENV]: octal(start) };
}

/**
 * The mask the AI's programs get: the start's, when it differs from
 * Daisy's own (null: nothing to change — not set up, the same, Windows).
 */
export function childUmask(): number | null {
  return start === null || start === OWNER_UMASK ? null : start;
}

/** Tests: what ownerOnlyUmask remembered (null: never called). */
export function resetStartUmask(m: number | null = null) {
  start = m;
}
