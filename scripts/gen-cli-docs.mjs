#!/usr/bin/env node
/**
 * Write the command reference (docs/guide/<lang>/commands.md) from the
 * `daisy` command's own tables: the local commands (packages/daisy/src/cli/
 * local) and the commands the route table generates (packages/contracts/
 * src/api, `cliTree`). Every block is what `daisy … --help` prints, captured
 * by running the command in process — nothing is written by hand twice.
 *
 *   node scripts/gen-cli-docs.mjs           # rewrite the files
 *   node scripts/gen-cli-docs.mjs --check   # exit 1 when a file is stale
 *   node scripts/gen-cli-docs.mjs --lang en # one language only
 *
 * P6-20 (ADR-159): the page's own words are the `docs.cli.*` keys of the
 * language packs and every help block is captured in that language, so
 * each language in CLI_DOC_LANGS gets its own page from the same tables.
 *
 * Mirrors scripts/gen-api-docs.ts. No Daisy is started and no data
 * directory is read: `--help` never leaves the process.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(import.meta.url);
const root = join(here, "..", "..");
/**
 * The languages whose reference is committed (ADR-159 §7): every help
 * block is captured in that language, so each page is the command line's
 * own text in that language. P6-23a added English (it replaced P6-21's
 * placeholder docs/guide/en/commands.md).
 */
export const CLI_DOC_LANGS = ["zh-CN", "en"];
export const cliDocFile = (lang) => `docs/guide/${lang}/commands.md`;
export const CLI_DOC = cliDocFile("zh-CN");

// The same output on every machine: no extra ACP harnesses from this
// shell's environment, no data directory, one platform for the text.
delete process.env.DAISY_ACP_HARNESSES;

/** Run `daisy <argv>` in process and return what it printed. */
async function capture(run, argv, lang) {
  const lines = [];
  const io = {
    env: { HOME: "/home/user", DAISY_LANG: lang },
    platform: "linux",
    out: (t) => lines.push(String(t)),
    err: (t) => lines.push(String(t)),
    write: () => {},
    stdinTTY: false,
    stdoutTTY: false,
    readSecret: async () => "",
    readLine: async () => "",
    readAll: async () => "",
    exec: async () => ({ code: 1, stdout: "", stderr: "", missing: true }),
    sleep: async () => {},
    openUrl: () => false,
  };
  const code = await run(argv, io);
  if (code !== 0) throw new Error(`daisy ${argv.join(" ")} exited ${code}: ${lines.join("\n")}`);
  // The first line of the top help names the version: not part of the reference.
  return lines
    .join("\n")
    .replace(/^(daisy —?— .+?)\s?[（(][^（）()]*[）)]$/m, "$1")
    .trimEnd();
}

const block = (text) => ["```text", text, "```", ""];

export async function cliDoc(lang = "zh-CN") {
  const { register } = await import("tsx/esm/api");
  register();
  const main = await import("../packages/daisy/src/cli/main.ts");
  const { LOCAL_COMMANDS, translator } = await import("../packages/contracts/src/index.ts");
  const { shippedPacks } = await import("../packages/contracts/src/i18n-node.ts");
  const { run, TREE } = main;
  const t = translator(shippedPacks(), lang);
  const leaves = (n) => (n.command ? [n.command] : n.children.flatMap(leaves));
  const cap = (argv) => capture(run, argv, lang);

  const out = [
    `# ${t("docs.cli.title")}`,
    "",
    // The link to the other language's page (docs/guide's convention, tests/guide-pages.test.ts).
    t("docs.cli.counterpart"),
    "",
    `<!-- ${t("docs.cli.generated")} -->`,
    "",
    t("docs.cli.intro"),
    "",
    `## ${t("docs.cli.overview")}`,
    "",
    ...block(await cap(["--help"])),
    `## ${t("docs.cli.local")}`,
    "",
  ];
  for (const name of LOCAL_COMMANDS) {
    out.push(`### daisy ${name}`, "", ...block(await cap([name, "--help"])));
  }
  out.push(`## ${t("docs.cli.api")}`, "");
  for (const group of TREE.children) {
    out.push(`### daisy ${group.name}`, "");
    if (group.command) {
      out.push(...block(await cap([group.name, "--help"])));
      continue;
    }
    out.push(...block(await cap([group.name, "--help"])));
    for (const c of leaves(group)) {
      out.push(`#### daisy ${c.path.join(" ")}`, "", ...block(await cap([...c.path, "--help"])));
    }
  }
  return out.join("\n").replace(/\n+$/, "\n");
}

if (process.argv[1] && resolve(process.argv[1]) === here) {
  const check = process.argv.includes("--check");
  const at = process.argv.indexOf("--lang");
  const langs = at >= 0 ? [process.argv[at + 1]] : CLI_DOC_LANGS;
  let stale = 0;
  for (const lang of langs) {
    const text = await cliDoc(lang);
    const rel = cliDocFile(lang);
    const file = join(root, rel);
    let old = "";
    try {
      old = readFileSync(file, "utf8");
    } catch {}
    if (old.replace(/\r\n/g, "\n") === text) continue;
    if (check) {
      console.error(`${rel} is stale (the command table changed): run node scripts/gen-cli-docs.mjs and commit it`);
      stale++;
    } else {
      writeFileSync(file, text);
      console.log(`wrote ${rel}`);
    }
  }
  process.exit(stale ? 1 : 0);
}
