/**
 * P1-09: build the installable package `@daisy-ai/daisy` (D-33)
 * from this checkout — `npm pack` of a staging directory, never
 * `npm publish` (the package is `private: true`, so npm refuses to
 * publish it by accident).
 *
 *   node --import tsx scripts/pack-daisy.ts [--out <dir>] [--no-web]
 *   npm install -g <dir>/daisy-ai-daisy-<version>.tgz   # → the `daisy` command
 *
 * The package keeps the repository's paths (packages/daisy/src/main.ts,
 * packages/daisy/bin/daisy.mjs …), so the code runs the same from a checkout
 * and from an install. What goes in: the Daisy process (server + runner),
 * the contracts, the command line and the built web page. What stays out:
 * tests, scripts, the native app's sources, every plugin package
 * (I-5: Daisy runs without any of them; P4-13: a
 * plugin is installed as its own package) and stage 4's parked code.
 *
 * Dependencies are what that code imports (scanned, so a new import cannot
 * be forgotten), at the versions of the root package.json; tsx runs the
 * TypeScript. `.release` marks the install (upgrade.ts: an installed
 * release, restarted into once idle after `npm install -g` of a newer one).
 */
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

/** Directories copied as they are (relative to the root). */
export const PACKED_DIRS = [
  "packages/daisy/src",
  "packages/daisy/bin",
  "packages/contracts/src",
  // P6-20 (ADR-159): the language packs (the contracts read them from ../locales).
  "packages/contracts/locales",
  // P4-09 (ADR-128): the A2A client and identity cards, shared with the standalone A2A MCP.
  "packages/a2a-client/src",
] as const;
/**
 * Single files copied as they are. P5-02 (ADR-144): the relay protocol's
 * constants — dependency-free on purpose, imported by Daisy's relay link;
 * the relay program itself is published on its own (ADR-143).
 */
export const PACKED_FILES = ["packages/relay/src/protocol.ts"] as const;
/** Never packed, wherever they appear. */
export const EXCLUDED = ["node_modules", "__tests__"];
export const WEB_DIR = "apps/app/dist";

const SOURCE = /\.(ts|mts|mjs|js|cjs)$/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (EXCLUDED.includes(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/** Bare package names a file imports (`zod`, `@fastify/static`, `ajv/dist/2020.js` → `ajv`). */
export function importsOf(text: string): string[] {
  const names = new Set<string>();
  const re =
    /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire(?:\.resolve)?\s*\(\s*)["']([^"'./][^"']*)["']/g;
  for (const m of text.matchAll(re)) {
    const spec = m[1]!;
    if (!/^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(\/[\w./-]*)?$/.test(spec)) continue;
    if (spec.startsWith("node:") || builtinModules.includes(spec.split("/")[0]!)) continue;
    const parts = spec.split("/");
    names.add(spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!);
  }
  return [...names];
}

export function dependenciesOf(files: string[], rootPkg: any): Record<string, string> {
  const all = { ...rootPkg.dependencies, ...rootPkg.devDependencies };
  const deps: Record<string, string> = { tsx: all.tsx };
  const missing: string[] = [];
  for (const f of files) {
    if (!SOURCE.test(f)) continue;
    for (const name of importsOf(readFileSync(f, "utf8"))) {
      // The repository's own workspace packages are not dependencies.
      if (name.startsWith("@daisy-ai/")) continue;
      if (all[name]) deps[name] = all[name];
      else missing.push(`${name}（${relative(root, f)}）`);
    }
  }
  if (missing.length)
    throw new Error(`these dependencies are not in the root package.json: ${[...new Set(missing)].join(", ")}`);
  return Object.fromEntries(Object.entries(deps).sort(([a], [b]) => a.localeCompare(b)));
}

export function release(rootPkg: any): string {
  let sha = "";
  try {
    sha = execFileSync("git", ["-C", root, "rev-parse", "--short=12", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {}
  return `${rootPkg.version}${sha ? "+" + sha : ""}`;
}

/** Stage the package in `dir` (empty). Returns its package.json. */
export function stage(dir: string, o: { web: boolean }): any {
  const rootPkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const files: string[] = [];
  for (const d of PACKED_DIRS) {
    const src = join(root, d);
    for (const f of walk(src)) {
      if (/\.test\.ts$/.test(f)) continue;
      const to = join(dir, relative(root, f));
      mkdirSync(resolve(to, ".."), { recursive: true });
      cpSync(f, to);
      files.push(f);
    }
  }
  for (const f of PACKED_FILES) {
    const to = join(dir, f);
    mkdirSync(resolve(to, ".."), { recursive: true });
    cpSync(join(root, f), to);
    files.push(join(root, f));
  }
  if (o.web) {
    const web = join(root, WEB_DIR);
    if (!existsSync(join(web, "index.html")))
      throw new Error(`no built web page (${WEB_DIR}/index.html): run npm run build:web first, or pass --no-web`);
    cpSync(web, join(dir, WEB_DIR), { recursive: true });
  }
  // D-40 ⑤: Apache-2.0 — the license text (and the NOTICE, §4(d)) goes in with the package.
  cpSync(join(root, "LICENSE"), join(dir, "LICENSE"));
  cpSync(join(root, "NOTICE"), join(dir, "NOTICE"));
  // P6-09: author / repository / homepage / bugs from packages/daisy/package.json.
  const meta = JSON.parse(readFileSync(join(root, "packages", "daisy", "package.json"), "utf8"));
  const pkg = {
    name: "@daisy-ai/daisy",
    version: rootPkg.version,
    description: "Daisy — your AI on your own machine: one process, one data directory, the `daisy` command",
    license: rootPkg.license,
    author: meta.author,
    repository: meta.repository,
    homepage: meta.homepage,
    bugs: meta.bugs,
    private: true,
    type: "module",
    bin: { daisy: "packages/daisy/bin/daisy.mjs" },
    // P5-06 (ADR-145): this release carries the start guard (update/guard.ts)
    // that confirms or rolls back a switch; an update only goes to a
    // package that says so (update/package.ts UPDATE_GUARD).
    daisy: { updateGuard: 1 },
    // P4-13: a plugin package installed next to Daisy (any package the
    // owner names, P6-16 / ADR-160) reaches the core only through this entry.
    exports: {
      ".": "./packages/daisy/src/main.ts",
      "./plugin": "./packages/daisy/src/plugins/api.ts",
      "./package.json": "./package.json",
    },
    engines: rootPkg.engines,
    os: ["linux", "darwin", "win32"],
    dependencies: dependenciesOf(files, rootPkg),
  };
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
  writeFileSync(join(dir, ".release"), release(rootPkg) + "\n");
  return pkg;
}

export function pack(o: { out: string; web: boolean }): string {
  const staging = mkdtempSync(join(tmpdir(), "daisy-pack-"));
  try {
    const pkg = stage(staging, o);
    mkdirSync(o.out, { recursive: true });
    const name = execFileSync("npm", ["pack", "--pack-destination", resolve(o.out), "--silent"], {
      cwd: staging,
      encoding: "utf8",
    })
      .trim()
      .split("\n")
      .pop()!;
    const tgz = join(resolve(o.out), name);
    console.log(`${pkg.name}@${pkg.version} → ${tgz}`);
    console.log(`install: npm install -g ${tgz} (not for publishing: package.json says private: true)`);
    return tgz;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

if (import.meta.main ?? process.argv[1] === import.meta.filename) {
  const args = process.argv.slice(2);
  const at = args.indexOf("--out");
  pack({ out: at >= 0 ? args[at + 1]! : join(root, "artifacts"), web: !args.includes("--no-web") });
}
