/**
 * P1-07 / P1-09: where this command's code is and how it starts the Daisy
 * process. The same layout serves a checkout (`node packages/daisy/bin/daisy.mjs`)
 * and an install (`npm install -g` of the package scripts/pack-daisy.ts
 * builds): the package keeps the repository's paths.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";

/** The repository / package root and the Daisy process's entry (shared with autostart). */
export { CODE_ROOT, SERVER_MAIN, serverCommand } from "../platform/autostart.ts";
import { CODE_ROOT } from "../platform/autostart.ts";

/** The npm package name (ADR-105, D-33). Never published by this work. */
export const PACKAGE_NAME = "@daisy-ai/daisy";

/** The minimum Node.js major version (package.json engines). */
export const NODE_MAJOR_MIN = 24;

function readJson(file: string): any {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** `.release` of the installed code (written by the packer), else null. */
export function installedRelease(root = CODE_ROOT): string | null {
  try {
    const v = readFileSync(join(root, ".release"), "utf8").trim();
    return /^[\w.+-]{1,100}$/.test(v) ? v : null;
  } catch {
    return null;
  }
}

export function codeVersion(root = CODE_ROOT): string {
  return readJson(join(root, "package.json"))?.version ?? "0.0.0";
}

/**
 * How this code was installed: by the package manager (a `.release`
 * under node_modules), a git checkout, or something else.
 */
export function installKind(root = CODE_ROOT): "package" | "checkout" | "other" {
  if (existsSync(join(root, ".git"))) return "checkout";
  if (installedRelease(root) && root.split(sep).includes("node_modules")) return "package";
  if (installedRelease(root)) return "package";
  return "other";
}

/** The node major version of `version` (`v24.1.0` → 24). */
export const nodeMajor = (version = process.version) =>
  Number(version.replace(/^v/, "").split(".")[0]) || 0;
