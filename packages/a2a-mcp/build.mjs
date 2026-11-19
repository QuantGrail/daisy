#!/usr/bin/env node
/**
 * P4-09 (ADR-128 §7): build the publishable `daisy-mcp` command —
 * src/bin.ts with the shared A2A client (packages/a2a-client) and the
 * contracts it uses bundled into one file, dist/daisy-mcp.mjs. Packages
 * (`@modelcontextprotocol/sdk`, `jose`, `zod`) stay imports and must be
 * this package's `dependencies` (checked here, so a new import cannot be
 * forgotten). Nothing of the Daisy process goes in (also checked).
 *
 *   node build.mjs [--outfile <file>]
 *
 * `npm pack` runs it (prepack). Never `npm publish` without the owner (D-22,
 * plan §10): the package is `private: true` until then.
 */
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";
import { inlinePacksPlugin, PACKS_MODULE } from "./inline-packs.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, "package.json"), "utf8"));
const at = process.argv.indexOf("--outfile");
const outfile = resolve(at > 0 ? process.argv[at + 1] : join(here, "dist", "daisy-mcp.mjs"));

const root = resolve(here, "..", "..");

// P6-23b (ADR-159 §10): the language packs go into the bundle (inline-packs.mjs).
const inlinePacks = inlinePacksPlugin(root);

const r = await build({
  absWorkingDir: root,
  entryPoints: [join(here, "src", "bin.ts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  packages: "external",
  metafile: true,
  logLevel: "warning",
  legalComments: "none",
  plugins: [inlinePacks],
});

const problems = [];
for (const [file, info] of Object.entries(r.metafile.inputs)) {
  // Paths are relative to the repository root (absWorkingDir).
  const rel = file.split("\\").join("/");
  if (rel !== `daisy-i18n:${PACKS_MODULE}` && (!/^packages\/(a2a-mcp|a2a-client|contracts)\/src\//.test(rel) || /\/i18n-node\.ts$/.test(rel))) problems.push(`a file that must not be bundled: ${rel}`);
  for (const imp of info.imports) {
    if (!imp.external) continue;
    const spec = imp.path;
    if (spec.startsWith("node:") || builtinModules.includes(spec.split("/")[0])) continue;
    const name = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
    if (!pkg.dependencies?.[name]) problems.push(`${rel} imports ${name}, which is not in package.json's dependencies`);
  }
}
if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.error(`built ${relative(process.cwd(), outfile) || outfile}`);
