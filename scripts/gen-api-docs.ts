/**
 * P1-06 (ADR-107): write the local API docs from the route table
 * (packages/contracts/src/api). `--check`: exit 1 when the committed
 * files differ (the same check runs in tests/api-defs.test.ts).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  API_GROUPS,
  API_ROUTES,
  API_VERSION,
  apiMarkdown,
  apiOpenApi,
  translator,
} from "../packages/contracts/src/index.ts";
import { shippedPacks } from "../packages/contracts/src/i18n-node.ts";

const here = fileURLToPath(import.meta.url);
const root = join(here, "..", "..");
/**
 * P6-20 / P6-23a (ADR-159 §7, D-44 ①): every word of the docs comes from
 * the language packs (`docs.api.*`, the routes' `api.route.*`, the fields'
 * `.describe()` keys). docs/api is a developers' reference and
 * openapi.json can hold one language: it is written in English only.
 */
export const API_DOC_LANG = "en";
export function apiDocFiles(lang = API_DOC_LANG): Record<string, string> {
  const t = translator(shippedPacks(), lang);
  const input = { routes: API_ROUTES, groups: API_GROUPS, apiVersion: API_VERSION, t };
  return {
    "docs/api/local-api.md": apiMarkdown(input),
    "docs/api/openapi.json": JSON.stringify(apiOpenApi(input), null, 2) + "\n",
  };
}

// Run directly (not imported by the test)? `import.meta.main` needs Node
// 24.2; the engines field allows 24.0.
if (process.argv[1] && resolve(process.argv[1]) === here) {
  const check = process.argv.includes("--check");
  let stale = 0;
  for (const [rel, text] of Object.entries(apiDocFiles())) {
    const file = join(root, rel);
    let old = "";
    try {
      old = readFileSync(file, "utf8");
    } catch {}
    if (old.replace(/\r\n/g, "\n") === text) continue;
    if (check) {
      console.error(`${rel} does not match the route definitions: run npm run gen:api and commit it`);
      stale++;
    } else {
      writeFileSync(file, text);
      console.log(`wrote ${rel}`);
    }
  }
  process.exit(stale ? 1 : 0);
}
