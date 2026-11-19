import { turnT } from "../harness/model-switch.ts";
import { homedir } from "node:os";
import {
  realpathSync,
  readdirSync,
  statSync,
  mkdirSync,
  lstatSync,
  accessSync,
  constants,
} from "node:fs";
import {
  resolve,
  relative,
  isAbsolute,
  dirname,
  basename,
  join,
  sep,
} from "node:path";
import type { NodeConfig } from "./worker.ts";
import type { DirectoryListing } from "../../../contracts/src/index.ts";
export function filesystemRoots(config: NodeConfig) {
  return config.allowedRoots.map((p) => realpathSync(p));
}
function within(path: string, roots: string[]) {
  return roots.some((root) => {
    const rel = relative(root, path);
    return (
      rel === "" ||
      (!rel.startsWith(".." + sep) && rel !== ".." && !isAbsolute(rel))
    );
  });
}
export function filesystemHome(config: NodeConfig) {
  const roots = filesystemRoots(config),
    home = realpathSync(config.workspaceHome || homedir());
  return within(home, roots) ? home : roots[0];
}
function requestedPath(input: string, config: NodeConfig) {
  if (input.length > 4096 || /[\x00-\x1f\x7f]/.test(input))
    throw Error(turnT()("server-turns.dir.badChars"));
  const home = filesystemHome(config),
    value = input.trim();
  if (
    value.startsWith("~") &&
    value !== "~" &&
    !value.startsWith("~/") &&
    !value.startsWith("~\\")
  )
    throw Error(turnT()("server-turns.dir.tildeOnly"));
  return resolve(
    home,
    value === "~"
      ? ""
      : value.startsWith("~/") || value.startsWith("~\\")
        ? value.slice(2)
        : value,
  );
}
function checked(path: string, roots: string[]) {
  const canonical = realpathSync(path);
  if (!within(canonical, roots)) throw Error(turnT()("server-turns.dir.outside"));
  if (!statSync(canonical).isDirectory()) throw Error(turnT()("server-turns.dir.notDir"));
  accessSync(canonical, constants.X_OK);
  return canonical;
}
export function browseDirectory(
  config: NodeConfig,
  input = "",
  offset = 0,
  hidden = false,
): DirectoryListing {
  const roots = filesystemRoots(config),
    path = checked(requestedPath(input, config), roots),
    home = filesystemHome(config);
  const names = readdirSync(path, { withFileTypes: true })
    .filter(
      (d) =>
        (hidden || !d.name.startsWith(".")) &&
        (d.isDirectory() || d.isSymbolicLink()),
    )
    .sort((a, b) => a.name.localeCompare(b.name));
  // Page candidate entries before resolving links. A huge directory cannot cause
  // unbounded stat calls or response size; nextOffset advances even past broken links.
  const entries = names.slice(offset, offset + 150).flatMap((d) => {
    try {
      const p = checked(join(path, d.name), roots);
      return [{ name: d.name, path: p, symlink: d.isSymbolicLink() }];
    } catch {
      return [];
    }
  });
  const up = dirname(path),
    parent = up !== path && within(up, roots) ? up : null;
  return {
    path,
    home,
    roots,
    parent,
    entries,
    nextOffset: offset + 150 < names.length ? offset + 150 : null,
  };
}
export function ensureDirectory(config: NodeConfig, input: string) {
  const roots = filesystemRoots(config),
    wanted = requestedPath(input, config),
    missing: string[] = [];
  let parent = wanted;
  while (true) {
    try {
      lstatSync(parent);
      break;
    } catch (e: any) {
      if (e.code !== "ENOENT") throw e;
      const up = dirname(parent);
      if (up === parent) throw Error(turnT()("server-turns.dir.noParent"));
      missing.unshift(basename(parent));
      parent = up;
    }
  }
  let current = checked(parent, roots);
  const created = missing.length > 0;
  for (const part of missing) {
    const next = join(current, part);
    if (!within(next, roots)) throw Error(turnT()("server-turns.dir.beyond"));
    try {
      mkdirSync(next, { mode: 0o700 });
    } catch (e: any) {
      if (e.code !== "EEXIST") throw e;
    }
    current = checked(next, roots);
  }
  return { path: current, created };
}
