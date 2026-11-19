/**
 * P1-07: the `daisy` command (5.10, ADR-107 §3, ADR-112).
 *
 * The command tree is the local commands (`LOCAL_COMMANDS`: start, stop,
 * status, open, update, doctor, uninstall, autostart — packages/daisy/src/cli/local)
 * merged with the subcommands the route table generates (`cliTree`); the
 * table's first words never collide with a local one (tests/api-defs.test.ts),
 * so every command is a leaf. Help comes from the same definitions
 * (`cliHelp`). Everything but the local commands goes through the local API
 * with the command line's credential — never the database.
 */
import {
  API_ROUTES,
  LOCAL_COMMANDS,
  cliTree,
  routeText,
  type CliNode,
} from "../../../contracts/src/index.ts";
import { dataDir as defaultDataDir } from "../platform/paths.ts";
import { resolve } from "node:path";
import { CliError, formatError, usageError } from "./errors.ts";
import { AutostartError } from "../platform/autostart.ts";
import { processIo, type Io } from "./io.ts";
import type { Ctx } from "./daisy.ts";
import { runTableCommand } from "./table.ts";
import { localHelp, runLocal } from "./local/commands.ts";
import { startProblems } from "./local/doctor.ts";
import { splitDataDirArg } from "../platform/settings.ts";
import { codeVersion, installedRelease } from "./code.ts";
import { setCliLanguage, t } from "./lang.ts";
import { resolveLanguage } from "../platform/language.ts";
import { matchLang, languagesOf } from "../../../contracts/src/i18n.ts";
import { packsFor } from "../../../contracts/src/i18n-node.ts";

export const TREE: CliNode = cliTree(API_ROUTES);

/** Groups with extra help (how their commands fit together): `cli.help.group.<name>`. */
const GROUP_NOTES = new Set(["login", "session"]);

/** A route's one-line summary in the command's language (`api.route.<id>.summary`). */
export const summaryOf = (c: { route: string }): string => routeText(c.route, "summary", t)!;

function nodeAt(words: string[]): { node: CliNode; used: number } {
  let node = TREE;
  let used = 0;
  for (const w of words) {
    const next = node.children.find((c) => c.name === w);
    if (!next) break;
    node = next;
    used++;
    if (node.command) break;
  }
  return { node, used };
}

const leaves = (n: CliNode): NonNullable<CliNode["command"]>[] =>
  n.command ? [n.command] : n.children.flatMap(leaves);

function groupHelp(path: string[], node: CliNode): string {
  const cmds = leaves(node);
  const width = Math.min(44, Math.max(...cmds.map((c) => c.path.slice(path.length).join(" ").length)) + 2);
  const group = path.join(" ");
  const lines = [t("cli.help.groupUsage", { group }), "", t("cli.help.subcommands")];
  for (const c of cmds)
    lines.push(`  ${c.path.slice(path.length).join(" ").padEnd(width)}${summaryOf(c)}${c.pin ? t("cli.help.needsPin") : ""}`);
  if (GROUP_NOTES.has(group)) lines.push("", t.dynamic(`cli.help.group.${group}`));
  lines.push("", t("cli.help.groupMore", { group }));
  return lines.join("\n");
}

function topHelp(): string {
  const release = installedRelease();
  const lines = [
    t("cli.help.title", { version: release ? t("cli.help.versionRelease", { version: codeVersion(), release }) : codeVersion() }),
    "",
    t("cli.help.usage"),
    "",
    t("cli.help.local"),
  ];
  const w = Math.max(...[...LOCAL_COMMANDS, ...TREE.children.map((c) => c.name)].map((n) => n.length)) + 2;
  for (const n of LOCAL_COMMANDS) lines.push(`  ${n.padEnd(w)}${t.dynamic(`cli.local.${n}.summary`)}`);
  lines.push("", t("cli.help.api"));
  for (const g of TREE.children) {
    const cmds = leaves(g);
    const words = cmds.map((c) => c.path.slice(1).join(" ") || "").filter(Boolean);
    const text = g.command ? summaryOf(g.command) : words.slice(0, 6).join(t("cli.list.separatorShort")) + (words.length > 6 ? " …" : "");
    lines.push(`  ${g.name.padEnd(w)}${text}`);
  }
  lines.push("", t("cli.help.firstUse"), "", t("cli.help.globals"));
  return lines.join("\n");
}

/** Pull the global options out of argv. */
function globals(argv: string[], io: Io): { rest: string[]; dataDir: string; version: boolean; lang?: string } {
  // P6-11 review: `--data-dir` is read by the same code as bin/daisy.mjs's
  // start settings (platform/settings.ts), so both use one directory.
  const split = splitDataDirArg(argv);
  if (split.missing) throw usageError(t("cli.usage.dataDirMissing"), t("cli.usage.dataDirMissingFix"));
  const rest: string[] = [];
  let version = false;
  let lang: string | undefined;
  for (let i = 0; i < split.rest.length; i++) {
    const a = split.rest[i]!;
    if (a === "--") {
      rest.push(...split.rest.slice(i));
      break;
    }
    // P6-20: `--lang <tag>` / `--lang=<tag>`, anywhere before `--`.
    if (a === "--lang" || a.startsWith("--lang=")) {
      const v = a === "--lang" ? split.rest[++i] : a.slice("--lang=".length);
      if (!v) throw usageError(t("cli.usage.langMissing"), t("cli.usage.langFix", { languages: "en, zh-CN" }));
      lang = v;
      continue;
    }
    if ((a === "-V" || a === "--version") && rest.length === 0) {
      version = true;
      continue;
    }
    rest.push(a);
  }
  const dataDir = split.dir ? resolve(split.dir) : defaultDataDir(io.env, io.platform);
  return { rest, dataDir, version, lang };
}

/**
 * P6-20: settle the command's language — `--lang` > DAISY_LANG > the
 * owner setting (config.json) > the system locale > English.
 */
function settleLanguage(g: { dataDir: string; lang?: string }, io: Io): void {
  const packs = packsFor(g.dataDir);
  const r = resolveLanguage({ env: io.env, platform: io.platform, dataDir: g.dataDir, useEnv: true, packs });
  setCliLanguage(r.lang, g.dataDir);
  if (g.lang === undefined) return;
  const m = matchLang(g.lang, languagesOf(packs));
  if (!m) throw usageError(t("cli.usage.langUnknown", { lang: g.lang }), t("cli.usage.langFix", { languages: languagesOf(packs).join(", ") }));
  setCliLanguage(m, g.dataDir);
}

/** Edit distance (for 「是不是想用」). */
function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length]![b.length]!;
}

function suggest(word: string, names: string[]): string {
  const near = names.filter((n) => distance(word, n) <= Math.max(1, Math.ceil(n.length / 3)) || (word.length >= 3 && n.startsWith(word)));
  return near.length ? t("cli.usage.didYouMean", { names: [...new Set(near)].slice(0, 4).join(t("cli.list.separatorShort")) }) : "";
}

/** Said once per process (a help that runs itself again is one command). */
let problemsSaid = false;

export async function run(argv: string[], io: Io): Promise<number> {
  try {
    // P6-11 (ADR-156): a broken start setting (runner.json, the extra ACP
    // harness file) is one line each, and the command goes on — doctor
    // and status show the same in their own output.
    // Before anything can fail: a failure is said in the right language.
    setCliLanguage(resolveLanguage({ env: io.env, platform: io.platform, useEnv: true }).lang);
    const g = globals(argv, io);
    settleLanguage(g, io);
    if (!problemsSaid) {
      problemsSaid = true;
      if (g.rest[0] !== "doctor" && g.rest[0] !== "status") for (const p of startProblems()) io.err(`✗ ${p}`);
    }
    // Children (the server we start) see the same data directory.
    const ctx: Ctx = { io: { ...io, env: { ...io.env, DAISY_DATA: g.dataDir } }, dataDir: g.dataDir };
    if (g.version) {
      io.out(`${codeVersion()}${installedRelease() ? ` (${installedRelease()})` : ""}`);
      return 0;
    }
    const words = g.rest;
    if (words.length === 0 || words[0] === "-h" || words[0] === "--help" || words[0] === "help") {
      if (words[0] === "help" && words.length > 1) return run([...words.slice(1), "--help"], io);
      io.out(topHelp());
      return 0;
    }
    const first = words[0]!;
    if ((LOCAL_COMMANDS as readonly string[]).includes(first)) return await runLocal(first, words.slice(1), ctx);
    const { node, used } = nodeAt(words);
    if (used === 0) {
      const all = [...LOCAL_COMMANDS, ...TREE.children.map((c) => c.name)];
      throw usageError(t("cli.usage.noCommand", { words: first }), `${suggest(first, all)}${t("cli.usage.seeAll")}`.trim());
    }
    const path = words.slice(0, used);
    if (node.command) return await runTableCommand(node.command, words.slice(used), ctx);
    const next = words[used];
    if (next === undefined || next === "-h" || next === "--help") {
      io.out(groupHelp(path, node));
      return 0;
    }
    throw usageError(
      t("cli.usage.noCommand", { words: [...path, next].join(" ") }),
      `${suggest(next, node.children.map((c) => c.name))}${t("cli.usage.seeGroup", { group: path.join(" ") })}`.trim(),
    );
  } catch (e) {
    if (e instanceof CliError) {
      io.err(formatError(e));
      return e.exitCode;
    }
    // Shared modules (autostart) say what happened and how to fix it too.
    if (e instanceof AutostartError) {
      io.err(formatError(new CliError(e.message, e.fix)));
      return 1;
    }
    io.err(
      formatError(
        new CliError(t("cli.error.unexpected", { message: (e as Error)?.message ?? String(e) }), t("cli.error.unexpectedFix")),
      ),
    );
    return 1;
  }
}

export async function main(argv: string[]): Promise<number> {
  return run(argv, processIo());
}

export { localHelp };
