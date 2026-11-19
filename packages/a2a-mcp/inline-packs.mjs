/**
 * P6-23b / P6-25 (ADR-159 §10): the language packs inside the `daisy-mcp`
 * bundle. The import of packages/contracts/src/i18n-node.ts (which reads
 * the packs from disk) becomes a module holding every shipped language's
 * `mcp` and `a2a` areas, plus the contracts' validation messages the
 * bundled schemas say (`server-contracts.a2a.*`, `server-contracts.message.*`),
 * so the command reads no locale file at run time (and takes no
 * data-directory pack). build.mjs uses it; so does the test that runs a
 * bundled schema.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Whole areas, and single keys by prefix from other areas. */
const AREAS = ["mcp", "a2a"];
const KEYS = { "server-contracts": ["server-contracts.a2a.", "server-contracts.message."] };
export const PACKS_MODULE = "inline-language-packs";

export function inlinedPacks(root) {
  const LOCALES = join(root, "packages", "contracts", "locales");
  const packs = {};
  for (const lang of readdirSync(LOCALES).sort()) {
    if (!statSync(join(LOCALES, lang)).isDirectory()) continue;
    const pack = {};
    for (const area of [...AREAS, ...Object.keys(KEYS)]) {
      let text;
      try {
        text = readFileSync(join(LOCALES, lang, `${area}.json`), "utf8");
      } catch {
        continue;
      }
      const take = (k) => (KEYS[area] ? KEYS[area].some((p) => k.startsWith(p)) : k.startsWith(area + "."));
      for (const [k, v] of Object.entries(JSON.parse(text))) if (take(k) && typeof v === "string") pack[k] = v;
    }
    if (Object.keys(pack).length) packs[lang] = pack;
  }
  return packs;
}

/** The esbuild plugin: i18n-node.ts → the inlined packs. */
export function inlinePacksPlugin(root) {
  return {
    name: "inline-language-packs",
    setup(b) {
      b.onResolve({ filter: /(^|\/)i18n-node\.ts$/ }, () => ({ path: PACKS_MODULE, namespace: "daisy-i18n" }));
      b.onLoad({ filter: /.*/, namespace: "daisy-i18n" }, () => ({
        contents: `const PACKS = ${JSON.stringify(inlinedPacks(root))};\nexport function shippedPacks() {\n  return PACKS;\n}\n`,
        loader: "js",
      }));
    },
  };
}
