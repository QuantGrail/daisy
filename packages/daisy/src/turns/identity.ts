import { turnT } from "../harness/model-switch.ts";
import { mkdirSync, chmodSync, rmSync } from "node:fs";
import { defaultStateRoot } from "../platform/paths.ts";
import { join } from "node:path";
import type { Profile } from "../../../contracts/src/index.ts";
import { log } from "../observe/log.ts";
/**
 * Where a managed identity's CLI directory is on this node — only for
 * `managed:<its own id>` with safe ids; null otherwise. Not created here.
 */
export function managedIdentityDir(
  configDir: string,
  profileId: string,
  nodeId: string,
  identityRoot?: string,
): string | null {
  if (
    configDir !== `managed:${profileId}` ||
    !/^[a-zA-Z0-9-]+$/.test(profileId) ||
    !/^[a-zA-Z0-9-]+$/.test(nodeId)
  )
    return null;
  return join(
    identityRoot || join(defaultStateRoot(), "identities"),
    nodeId,
    profileId,
  );
}
export function resolveIdentity(
  profile: Profile,
  nodeId: string,
  identityRoot?: string,
) {
  if (!profile.configDir?.startsWith("managed:")) return profile;
  const dir = managedIdentityDir(
    profile.configDir,
    profile.id,
    nodeId,
    identityRoot,
  );
  if (!dir) throw Error(turnT()("server-turns.identity.badDir"));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return { ...profile, configDir: dir };
}

/**
 * Remove the CLI directories of managed identities deleted on the control
 * plane (state sync retiredIdentities). Only ids of this node under the
 * identity root; missing directories are fine. Returns ids actually removed.
 */
export function retireIdentities(
  ids: unknown,
  nodeId: string,
  identityRoot?: string,
) {
  if (!Array.isArray(ids) || !/^[a-zA-Z0-9-]+$/.test(nodeId)) return [];
  const root = join(
    identityRoot || join(defaultStateRoot(), "identities"),
    nodeId,
  );
  const removed: string[] = [];
  for (const id of ids)
    if (typeof id === "string" && /^[a-zA-Z0-9-]+$/.test(id)) {
      const dir = join(root, id);
      try {
        rmSync(dir, { recursive: true, force: true });
        removed.push(id);
      } catch (e) {
        log.error("Could not remove retired identity", id, e);
      }
    }
  return removed;
}
