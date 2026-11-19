/**
 * P4-09 (ADR-128 §6): the `daisy-mcp` command.
 *
 *   daisy-mcp [serve] [--agent-name <名字>]   the MCP server on stdio (what a harness starts)
 *   daisy-mcp card [--name <名字>] [--note <备注>]
 *                                            print this MCP's identity card (no address);
 *                                            give it to a Daisy owner to import as a contact
 *   daisy-mcp import [<文件>|-] [--expect-id <编号>] [--update] [--yes]
 *                                            import another Daisy's identity card
 *   daisy-mcp contacts                       the address book
 *   daisy-mcp remove <编号> [--yes]          remove a contact
 *   --home <目录>                            where the key and address book live
 *                                            (else DAISY_MCP_HOME, else the system's config directory)
 *
 * Importing and removing contacts is only here, for the owner at a terminal:
 * the MCP tools cannot do either (5.11: an AI cannot add contacts).
 */
import { createInterface } from "node:readline/promises";
import { readFileSync } from "node:fs";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { cardText, expectIdMatches, groupedId, readCard, type OutboundPolicy } from "../../a2a-client/src/index.ts";
import { IDENTITY_CARD_LIMITS } from "../../contracts/src/limits.ts";
import { MCP_COMMAND_NAME, MCP_NAME } from "../../contracts/src/names.ts";
import { Home, HomeError, homeDir } from "./home.ts";
import { McpIdentity } from "./identity.ts";
import { AddressBook, ImportError, verifyHint } from "./contacts.ts";
import { pt, processLanguage, setProcessLanguage, takeLangFlag } from "../../contracts/src/i18n-process.ts";
import { hasDefaultTranslate, setDefaultTranslate } from "../../contracts/src/i18n-default.ts";
import { McpClient, type Limits } from "./calls.ts";
import { serve } from "./server.ts";
import { VERSION } from "./version.ts";

/*
 * P6-25 (ADR-159): the contracts' own validation messages (an A2A part,
 * a message) say their text through the default translator. In Daisy
 * `i18n-node.ts` registers it; the bundle replaces that module with its
 * inlined packs, so here this command's language is the default.
 */
if (!hasDefaultTranslate()) setDefaultTranslate(() => pt);

export interface MainOptions {
  /** Tests only: what the outbound connections may relax (loopback). Never set by bin.ts. */
  policy?: OutboundPolicy;
  /** Tests only: shorter polling. */
  limits?: Partial<Limits>;
  env?: Record<string, string | undefined>;
}

/** `--help` (said when asked: the language is settled by then). */
const help = () => pt("mcp.help", { name: MCP_NAME, version: VERSION, cmd: MCP_COMMAND_NAME });

interface Parsed {
  cmd: string;
  pos: string[];
  flags: Record<string, string | true>;
}

const VALUE_FLAGS = new Set(["home", "name", "note", "expect-id", "agent-name"]);
const BOOL_FLAGS = new Set(["update", "yes", "help", "version", "json"]);

function parse(argv: string[]): Parsed {
  const pos: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "-h") flags.help = true;
    else if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const name = a.slice(2, eq > 0 ? eq : undefined);
      if (VALUE_FLAGS.has(name)) {
        const v = eq > 0 ? a.slice(eq + 1) : argv[++i];
        if (v === undefined) throw new UsageError(pt("mcp.cli.needsValue", { flag: `--${name}` }));
        flags[name] = v;
      } else if (BOOL_FLAGS.has(name)) flags[name] = true;
      else throw new UsageError(pt("mcp.cli.unknownOption", { flag: `--${name}` }));
    } else pos.push(a);
  }
  return { cmd: pos.shift() ?? "serve", pos, flags };
}

class UsageError extends Error {}

const out = (s: string) => process.stdout.write(s + "\n");
const err = (s: string) => process.stderr.write(s + "\n");

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = (await rl.question(question)).trim().toLowerCase();
    return pt("mcp.confirm.yes").split("|").some((y) => y.trim().toLowerCase() === answer);
  } finally {
    rl.close();
  }
}

/** Run one command; the exit code. */
export async function main(argv: string[], o: MainOptions = {}): Promise<number> {
  // P6-23b (ADR-159 §10): `--lang` > DAISY_LANG > the system locale > English.
  const flag = takeLangFlag(argv);
  argv = flag.rest;
  setProcessLanguage(processLanguage(flag.lang, { env: { ...process.env, ...o.env }, platform: process.platform }));
  let p: Parsed;
  try {
    p = parse(argv);
  } catch (e) {
    err(`${(e as Error).message}\n\n${help()}`);
    return 2;
  }
  if (p.flags.help || p.cmd === "help") {
    out(help());
    return 0;
  }
  if (p.flags.version) {
    out(VERSION);
    return 0;
  }
  try {
    const home = new Home(homeDir(p.flags.home as string | undefined, o.env ?? process.env)).ensure();
    const self = McpIdentity.open(home);
    const book = new AddressBook(home, self.id);
    switch (p.cmd) {
      case "serve": {
        const client = new McpClient({
          home,
          self,
          book,
          ...(typeof p.flags["agent-name"] === "string" ? { agentName: p.flags["agent-name"] } : {}),
          ...(o.policy ? { policy: o.policy } : {}),
          ...(o.limits ? { limits: o.limits } : {}),
        });
        const transport = new StdioServerTransport();
        // The harness closing our stdin ends the server.
        process.stdin.once("end", () => void transport.close());
        await serve(client, transport);
        return 0;
      }
      case "card": {
        const profile = home.readJson<{ name?: string; note?: string | null }>("profile.json", {});
        const name = typeof p.flags.name === "string" ? p.flags.name : profile.name;
        if (!name) {
          err(pt("mcp.cli.cardNeedsName", { max: IDENTITY_CARD_LIMITS.nameMax, cmd: MCP_COMMAND_NAME }));
          return 2;
        }
        const note = typeof p.flags.note === "string" ? p.flags.note || null : (profile.note ?? null);
        const card = await self.card(name, note);
        if (name !== profile.name || note !== (profile.note ?? null)) home.writeJson("profile.json", { name, note });
        out(cardText(card));
        err(`\n${pt("mcp.cli.cardGive")}\n${verifyHint()}`);
        return 0;
      }
      case "import": {
        const src = p.pos[0];
        const text = !src || src === "-" ? await readStdin() : readFileSync(src, "utf8");
        // Verify first, show what it is, then take it only when confirmed.
        let card;
        try {
          card = await readCard(text);
        } catch (e) {
          err((e as Error).message);
          return 1;
        }
        // Refused before anything is asked (the same checks book.import makes again).
        if (card.id === self.id) throw new ImportError("contact_self", "mcp.import.self", { name: MCP_NAME });
        if (typeof p.flags["expect-id"] === "string" && !expectIdMatches(p.flags["expect-id"], card.id))
          throw new ImportError("id_mismatch", "mcp.import.idMismatch", { id: groupedId(card.id) });
        const sep = pt("mcp.list.separator");
        err(
          [
            pt("mcp.cli.showCard", { name: card.name }),
            pt("mcp.cli.showNumber", { id: groupedId(card.id) }),
            pt("mcp.cli.showAddrs", {
              addrs: card.addrs.map((a) => pt("mcp.cli.addrKind", { url: a.url, kind: a.kind })).join(sep) || pt("mcp.cli.noAddress"),
            }),
            ...(card.note ? [pt("mcp.cli.showNote", { note: card.note })] : []),
            verifyHint(),
          ].join("\n"),
        );
        if (!p.flags.yes) {
          const tty = process.stdin.isTTY && src && src !== "-";
          if (!tty || !(await confirm(pt("mcp.cli.importConfirm")))) {
            err(pt(tty ? "mcp.cli.notImported" : "mcp.cli.notImportedHowTo"));
            return 1;
          }
        }
        const r = await book.import(text, {
          ...(typeof p.flags["expect-id"] === "string" ? { expectId: p.flags["expect-id"] } : {}),
          ...(p.flags.update ? { update: true } : {}),
        });
        out(
          r.result === "added"
            ? pt("mcp.cli.added", { name: r.contact.name, id: r.contact.id })
            : r.result === "updated"
              ? pt("mcp.cli.updated", {
                  name: r.contact.name,
                  id: r.contact.id,
                  fields: r.changes.map((c) => c.field).join(pt("mcp.list.separator")) || pt("mcp.cli.updatedCard"),
                })
              : pt("mcp.cli.unchanged", { name: r.contact.name, id: r.contact.id }),
        );
        if (r.result === "added") err(pt("mcp.cli.addedNext", { cmd: MCP_COMMAND_NAME }));
        return 0;
      }
      case "contacts": {
        const list = await book.list();
        if (p.flags.json) {
          out(JSON.stringify(list.map((c) => ({ id: c.id, name: c.name, note: c.note, addrs: c.addrs, iat: c.iat, addedAt: c.addedAt }))));
          return 0;
        }
        if (!list.length) out(pt("mcp.cli.bookEmpty", { cmd: MCP_COMMAND_NAME }));
        for (const c of list)
          out(pt("mcp.cli.contactRow", { id: c.id, name: c.name, addrs: c.addrs.map((a) => a.url).join(" ") || pt("mcp.cli.noAddress") }));
        out(`\n${pt("mcp.cli.myNumber", { id: self.id })}`);
        return 0;
      }
      case "remove": {
        const ref = p.pos[0];
        if (!ref) throw new UsageError(pt("mcp.cli.removeNeedsId", { cmd: MCP_COMMAND_NAME }));
        const found = await book.find(ref);
        if (found.length !== 1) {
          err(pt(found.length ? "mcp.cli.removeAmbiguous" : "mcp.cli.removeNotFound"));
          return 1;
        }
        const c = found[0]!;
        if (!p.flags.yes && !(process.stdin.isTTY && (await confirm(pt("mcp.cli.removeConfirm", { name: c.name, id: groupedId(c.id) }))))) {
          err(pt("mcp.cli.notRemoved"));
          return 1;
        }
        await book.remove(c.id);
        out(pt("mcp.cli.removed", { name: c.name, id: c.id }));
        return 0;
      }
      default:
        throw new UsageError(pt("mcp.cli.unknownCommand", { cmd: p.cmd }));
    }
  } catch (e) {
    if (e instanceof UsageError) {
      err(`${e.message}\n\n${help()}`);
      return 2;
    }
    if (e instanceof ImportError) {
      err(e.message + (e.details.length ? `\n${e.details.join("\n")}` : ""));
      return 1;
    }
    if (e instanceof HomeError) {
      err(e.message);
      return 1;
    }
    throw e;
  }
}
