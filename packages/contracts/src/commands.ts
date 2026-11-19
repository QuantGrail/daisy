import type { Agent } from "./index";
import type { AgentFeature } from "./agent-capabilities.ts";
import type { Translate } from "./i18n.ts";
export interface AgentCommand {
  name: string;
  title: string;
  description: string;
  kind: "local" | "operation" | "prompt" | "terminal";
  args?: string;
}
/**
 * The built-in menu entries (P6-22, ADR-159): names and kinds here, their
 * title and description in the language packs
 * (`ui-contracts.command.<name>.title` / `.description`).
 */
const COMMON_COMMANDS: readonly { name: string; kind: AgentCommand["kind"] }[] = [
  { name: "help", kind: "local" },
  { name: "new", kind: "local" },
  { name: "resume", kind: "local" },
  { name: "model", kind: "local" },
  { name: "permissions", kind: "local" },
  { name: "status", kind: "local" },
  { name: "compact", kind: "operation" },
  { name: "fork", kind: "operation" },
  { name: "rewind", kind: "local" },
  { name: "skills", kind: "operation" },
  { name: "mcp", kind: "local" },
  { name: "plugins", kind: "local" },
  { name: "config", kind: "local" },
  { name: "terminal", kind: "local" },
  { name: "stop", kind: "local" },
  { name: "export", kind: "local" },
];
/** A built-in entry in `t`'s language. */
const builtIn = (name: string, kind: AgentCommand["kind"], t: Translate): AgentCommand => ({
  name,
  title: t.dynamic(`ui-contracts.command.${name}.title`),
  description: t.dynamic(`ui-contracts.command.${name}.description`),
  kind,
});
/** The commands every agent has, in `t`'s language. */
export const commonCommands = (t: Translate): AgentCommand[] =>
  COMMON_COMMANDS.map((c) => builtIn(c.name, c.kind, t));
/**
 * P4-11 (§5.5, C-3): the menu entries that need a declared capability —
 * an AI that does not declare it does not get the entry. `model` needs
 * either the model or the effort to be switchable.
 */
export const COMMAND_FEATURES: Record<string, AgentFeature[]> = {
  compact: ["compact"],
  fork: ["fork"],
  rewind: ["rewind"],
  model: ["model", "effort"],
  permissions: ["permissionMode"],
  terminal: ["terminal"],
};
/** Whether the command is offered by `features` (absent: an older server — all). */
export const commandOffered = (
  name: string,
  features?: Partial<Record<AgentFeature, string>> | null,
) =>
  !features ||
  !COMMAND_FEATURES[name] ||
  COMMAND_FEATURES[name]!.some((k) => (features[k] ?? "none") !== "none");
export function commandList(
  agent: Agent,
  discovered: AgentCommand[] = [],
  /** P4-11: the session's declared capabilities (snapshot `features`). */
  features: Partial<Record<AgentFeature, string>> | null | undefined,
  /** The UI's language (`useT()`). */
  t: Translate,
) {
  const items = commonCommands(t).filter((c) => commandOffered(c.name, features));
  // 「换身份」 and the identity's model slots (Claude Code).
  if (agent === "claude")
    items.splice(items.findIndex((x) => x.name === "permissions") + 1, 0, builtIn("identity", "local", t));
  if (agent === "codex")
    items.push(builtIn("review", "operation", t));
  for (const c of discovered)
    if (
      !items.some((x) => x.name === c.name) &&
      // Not the same name back as the harness's own prompt command.
      commandOffered(c.name, features)
    )
      items.push(c);
  return items;
}
export interface AgentOperation {
  name: string;
  args?: Record<string, any>;
}
