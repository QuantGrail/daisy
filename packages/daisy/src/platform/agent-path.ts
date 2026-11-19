import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import {
  ACP_AGENTS,
  ACP_HARNESSES,
} from "../../../contracts/src/acp-harnesses.ts";
/**
 * Per-user places where agent CLIs get installed (Claude / Codex native
 * installers and npm prefixes → ~/.local/bin, Kimi → ~/.kimi-code/bin, …).
 *
 * The Runner's service PATH is written once, at enrolment; a directory that
 * did not exist then (a CLI installed afterwards creates it) was never on it,
 * so the Runner reported 「未检测到」 for a CLI that runs fine in the member's
 * shell (2026-11-05, yikang.li: Claude in ~/.local/bin). The Runner now adds
 * these directories itself, after the configured PATH (which keeps
 * precedence), every time it detects the agents.
 */
export const USER_BIN_DIRS = [
  ".local/bin",
  // P4-10: the ACP harnesses' own install directories (acp-harnesses.ts).
  ...new Set(ACP_AGENTS.flatMap((a) => ACP_HARNESSES[a]!.binDirs ?? [])),
  ".npm-global/bin",
  ".bun/bin",
  ".claude/local",
  "bin",
];
const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};
/** Appends the user's CLI directories that exist and are missing; returns the added ones. */
export function ensureUserBins(
  env: Record<string, string | undefined> = process.env,
  home = homedir(),
): string[] {
  const parts = (env.PATH || "").split(delimiter).filter(Boolean);
  const added: string[] = [];
  for (const d of USER_BIN_DIRS) {
    const p = join(home, d);
    if (!parts.includes(p) && existsSync(p) && isDir(p)) {
      parts.push(p);
      added.push(p);
    }
  }
  if (added.length) env.PATH = parts.join(delimiter);
  return added;
}
/** How often the Runner looks for newly installed agent CLIs. */
export const AGENT_REDETECT_MS = 5 * 60_000;
