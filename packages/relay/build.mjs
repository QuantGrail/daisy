#!/usr/bin/env node
/**
 * P5-01 (ADR-143): build the publishable `daisy-relay` command —
 * src/bin.ts with the identity-number code it shares with Daisy
 * (packages/a2a-client/src/identity.ts) and the product names bundled into one file, dist/daisy-relay.mjs. Packages
 * (`ws`, `jose`) stay imports and must be
 * this package's `dependencies` (checked here, so a new import cannot be
 * forgotten). Nothing of the Daisy process goes in (also checked: ADR-103, the relay does not depend on Daisy).
 *
 *   node build.mjs [--outfile <file>]
 *
 * `npm pack` runs it (prepack). Never `npm publish` without the owner (D-22,
 * plan §10): the package is `private: true` until then.
 */
import { build } from "esbuild";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, "package.json"), "utf8"));
const at = process.argv.indexOf("--outfile");
const outfile = resolve(at > 0 ? process.argv[at + 1] : join(here, "dist", "daisy-relay.mjs"));

const root = resolve(here, "..", "..");

/*
 * P6-23b (ADR-159 §10): the language packs go into the bundle. The import
 * of packages/contracts/src/i18n-node.ts (which reads the packs from disk)
 * becomes a module holding every shipped language's AREAS, so the command
 * reads no locale file at run time (and takes no data-directory pack).
 */
const AREAS = ["relay"];
const LOCALES = join(root, "packages", "contracts", "locales");
const PACKS_MODULE = "inline-language-packs";
function inlinedPacks() {
  const packs = {};
  for (const lang of readdirSync(LOCALES).sort()) {
    if (!statSync(join(LOCALES, lang)).isDirectory()) continue;
    const pack = {};
    for (const area of AREAS) {
      let text;
      try {
        text = readFileSync(join(LOCALES, lang, `${area}.json`), "utf8");
      } catch {
        continue;
      }
      for (const [k, v] of Object.entries(JSON.parse(text))) if (k.startsWith(area + ".") && typeof v === "string") pack[k] = v;
    }
    if (Object.keys(pack).length) packs[lang] = pack;
  }
  return packs;
}
const inlinePacks = {
  name: "inline-language-packs",
  setup(b) {
    b.onResolve({ filter: /(^|\/)i18n-node\.ts$/ }, () => ({ path: PACKS_MODULE, namespace: "daisy-i18n" }));
    b.onLoad({ filter: /.*/, namespace: "daisy-i18n" }, () => ({
      contents: `const PACKS = ${JSON.stringify(inlinedPacks())};\nexport function shippedPacks() {\n  return PACKS;\n}\n`,
      loader: "js",
    }));
  },
};

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
  if (
    rel !== `daisy-i18n:${PACKS_MODULE}` &&
    !/^packages\/(relay\/src\/|a2a-client\/src\/(identity|constants)\.ts$|contracts\/src\/(names|i18n|i18n-process)\.ts$)/.test(rel)
  )
    problems.push(`a file that must not be bundled: ${rel}`);
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
