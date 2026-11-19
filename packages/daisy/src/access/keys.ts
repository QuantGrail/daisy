/**
 * P1-03: the `keys/` directory of the data directory (ADR-102 layout,
 * ADR-099 E1): 0700, every file in it 0600, owned by the owner. Files are
 * created with those modes and re-checked when read: a loose or foreign
 * file stops start-up with how to fix it (readSecretFile).
 */
import { chmodSync, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setOwnerOnly } from "../platform/windows/acl.ts";

export const keysDir = (dataDir: string) => join(dataDir, "keys");

export function ensureKeysDir(dataDir: string): string {
  const dir = keysDir(dataDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(dir, 0o700);
  // Windows (P5-05): a protected owner-only DACL, inherited by every file
  // written inside (writeSecret's temporary file included).
  else setOwnerOnly(dir);
  return dir;
}

/** Write a secret file 0600 (through a temporary file: never half-written). */
export function writeSecret(path: string, content: string | Buffer): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, content, { mode: 0o600, flag: "w" });
  if (process.platform !== "win32") chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

export const exists = existsSync;
