import { textsOf } from "../harness/shared.ts";
import { turnT } from "../harness/model-switch.ts";
import {
  readFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  readdirSync,
  realpathSync,
  lstatSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, relative, isAbsolute } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import TOML from "@iarna/toml";
import type { Runtime } from "../harness/shared.ts";
import { acpHarness } from "../../../contracts/src/acp-harnesses.ts";
const secret = /api.?key|token|secret|password|authorization|credential/i;
// What a secret reads as (the owner's language); any language's mark keeps the old value.
const mask = () => turnT()("server-turns.config.mask");
export function redactConfig(value: any): any {
  if (Array.isArray(value)) return value.map(redactConfig);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        secret.test(k) && v ? mask() : redactConfig(v),
      ]),
    );
  if (typeof value === "string")
    return value.replace(
      /(?:sk-[A-Za-z0-9_-]{12,}|Bearer\s+[A-Za-z0-9._-]{16,})/g,
      mask(),
    );
  return value;
}
function preserve(value: any, old: any): any {
  if (typeof value === "string" && textsOf("server-turns.config.mask").has(value)) return old;
  if (Array.isArray(value)) return value.map((v, i) => preserve(v, old?.[i]));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, preserve(v, old?.[k])]),
    );
  return value;
}
export function configLocation(rt: Runtime, kind: "main" | "mcp" = "main") {
  const agent = rt.job.session.agent;
  // P4-10: an ACP harness's files come from its entry (acp-harnesses.ts);
  // one without them is not managed here.
  const h = acpHarness(agent);
  if (h && (!h.nativeConfig || !h.configDir))
    throw Error(turnT()("server-turns.config.notManaged", { short: h.short, name: h.name }));
  const dir =
    rt.job.profile.configDir ||
    join(
      homedir(),
      h
        ? h.configDir!.home
        : { claude: ".claude", codex: ".codex" }[agent as "claude" | "codex"],
    );
  const file = h
    ? kind === "mcp"
      ? h.nativeConfig!.mcp
      : h.nativeConfig!.main
    : kind === "mcp"
      ? "mcp.json"
      : agent === "claude"
        ? "settings.json"
        : "config.toml";
  return {
    dir,
    file: join(dir, file),
    format: /\.toml$/.test(file) ? "toml" : "json",
  };
}
export function assertManaged(rt: Runtime) {
  if (!rt.managedIdentity)
    throw Error(
      turnT()("server-turns.config.needManaged"),
    );
}
export function readConfiguration(rt: Runtime, kind: "main" | "mcp" = "main") {
  const { file, format } = configLocation(rt, kind),
    text = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (text.length > 200000) throw Error(turnT()("server-turns.config.tooLarge"));
  const value = text.trim()
    ? format === "json"
      ? JSON.parse(text)
      : TOML.parse(text)
    : {};
  return {
    text,
    value,
    version: createHash("sha256").update(text).digest("hex"),
    file,
    format,
  };
}
export function saveConfiguration(
  rt: Runtime,
  value: any,
  expectedVersion: string,
  kind: "main" | "mcp" = "main",
) {
  assertManaged(rt);
  const old = readConfiguration(rt, kind);
  if (old.version !== expectedVersion)
    throw Error(turnT()("server-turns.config.changed"));
  const merged = preserve(value, old.value);
  const text =
    old.format === "json"
      ? JSON.stringify(merged, null, 2) + "\n"
      : TOML.stringify(merged);
  const { dir } = configLocation(rt);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (existsSync(old.file) && lstatSync(old.file).isSymbolicLink())
    throw Error(turnT()("server-turns.config.symlink"));
  // P6-03: was .harbor-backups (old backups stay there).
  const backup = join(dir, ".daisy-backups");
  mkdirSync(backup, { recursive: true, mode: 0o700 });
  if (old.text)
    writeFileSync(join(backup, Date.now() + "-" + randomUUID()), old.text, {
      mode: 0o600,
    });
  const tmp = old.file + ".daisy-" + randomUUID();
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, old.file);
  return {
    saved: true,
    version: createHash("sha256").update(text).digest("hex"),
  };
}
export function localSkills(rt: Runtime) {
  const { dir } = configLocation(rt),
    roots = [
      join(dir, "skills"),
      join(
        rt.cwd,
        acpHarness(rt.job.session.agent)?.nativeConfig?.projectDir ??
          "." + rt.job.session.agent,
        "skills",
      ),
      join(rt.cwd, ".agents", "skills"),
    ];
  const skills: any[] = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root, { withFileTypes: true }).slice(
      0,
      300,
    )) {
      const file = join(root, entry.name, "SKILL.md");
      if ((entry.isDirectory() || entry.isSymbolicLink()) && existsSync(file))
        skills.push({
          name: entry.name,
          path: file,
          description: readFileSync(file, "utf8").slice(0, 400),
        });
    }
  }
  return skills;
}
export function saveSkill(rt: Runtime, name: string, content: string) {
  assertManaged(rt);
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(name) || content.length > 100000)
    throw Error(turnT()("server-turns.skill.invalid"));
  const { dir } = configLocation(rt),
    root = join(dir, "skills"),
    dest = join(root, name);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  mkdirSync(dest, { recursive: true, mode: 0o700 });
  const rel = relative(realpathSync(root), realpathSync(dest));
  if (rel.startsWith("..") || isAbsolute(rel))
    throw Error(turnT()("server-turns.skill.outside"));
  const file = join(dest, "SKILL.md");
  if (existsSync(file) && lstatSync(file).isSymbolicLink())
    throw Error(turnT()("server-turns.skill.symlink"));
  if (existsSync(file))
    writeFileSync(file + ".backup-" + Date.now(), readFileSync(file), {
      mode: 0o600,
    });
  writeFileSync(file, content, { mode: 0o600 });
  return { saved: true, path: file };
}
