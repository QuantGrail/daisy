#!/usr/bin/env node
// P1-07: the `daisy` command. Checks Node first (so an old Node gets a
// sentence, not a syntax error), then loads the TypeScript sources with
// tsx — the same way the Daisy process itself runs.
import { readFileSync } from "node:fs";
const major = Number(process.versions.node.split(".")[0]);
if (major < 24) {
  process.stderr.write(oldNodeText() + "\n");
  process.exit(1);
}

/**
 * P6-23a (ADR-159): the sentence in the language packs, read without any
 * of Daisy's code (this Node may be too old for it): `--lang`, DAISY_LANG,
 * the POSIX locale variables — Chinese for zh*, else English.
 */
function oldNodeText() {
  const argv = process.argv.slice(2);
  const at = argv.findIndex((a) => a === "--lang" || a.startsWith("--lang="));
  const flag = at < 0 ? "" : argv[at] === "--lang" ? argv[at + 1] || "" : argv[at].slice(7);
  const e = process.env;
  const tag = flag || e.DAISY_LANG || e.LC_ALL || e.LC_MESSAGES || e.LANG || "";
  const lang = /^zh/i.test(tag) ? "zh-CN" : "en";
  const key = "cli.bin.oldNode";
  let text = key;
  for (const l of [lang, "en"]) {
    try {
      const pack = JSON.parse(readFileSync(new URL(`../../contracts/locales/${l}/cli.json`, import.meta.url), "utf8"));
      if (pack[key]) {
        text = pack[key];
        break;
      }
    } catch {}
  }
  return text.replace(/\{version\}/g, process.version).replace(/\{product\}/g, "Daisy").replace(/\{command\}/g, "daisy");
}
const { register } = await import("tsx/esm/api");
register();
// P6-11 (ADR-156): runner.json's start settings (extra ACP harnesses, agent
// commands, port) into this process's environment before the harness
// table loads — the command line sees the harnesses the Daisy process
// sees, with or without the environment variables.
const settings = await import("../src/platform/settings.ts");
const paths = await import("../src/platform/paths.ts");
settings.applyStartSettings(settings.argvDataDir(process.argv.slice(2)) ?? paths.dataDir());
const { main } = await import("../src/cli/main.ts");
process.exitCode = await main(process.argv.slice(2));
