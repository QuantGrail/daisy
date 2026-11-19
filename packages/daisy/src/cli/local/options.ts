/** P1-07: options of the local commands (a tiny parser; the table's are generated). */
import { usageError } from "../errors.ts";
import { t } from "../lang.ts";

export interface LocalSpec {
  /** `--name` → takes a value? */
  flags: Record<string, "bool" | "value">;
  /** Positional words allowed (names, for the error). */
  args?: string[];
}

export interface LocalArgs {
  flags: Record<string, string | true>;
  args: string[];
  help: boolean;
}

export function parseLocal(cmd: string, argv: string[], spec: LocalSpec): LocalArgs {
  const out: LocalArgs = { flags: {}, args: [], help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "-h" || a === "--help") {
      out.help = true;
      continue;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const name = eq > 0 ? a.slice(0, eq) : a;
      const kind = spec.flags[name];
      if (!kind)
        throw usageError(
          t("cli.options.noSuchOption", { cmd, name }),
          Object.keys(spec.flags).length
            ? t("cli.options.available", { cmd, options: Object.keys(spec.flags).join(t("cli.list.separatorShort")) })
            : t("cli.options.none", { cmd }),
        );
      if (kind === "bool") {
        if (eq > 0) throw usageError(t("cli.options.noValue", { name }), t("cli.options.noValueFix", { name }));
        out.flags[name] = true;
      } else {
        const v = eq > 0 ? a.slice(eq + 1) : argv[++i];
        if (v === undefined || v === "") throw usageError(t("cli.options.missingValue", { name }), t("cli.options.missingValueFix", { name }));
        out.flags[name] = v;
      }
      continue;
    }
    out.args.push(a);
  }
  const max = spec.args?.length ?? 0;
  if (!out.help && out.args.length > max)
    throw usageError(t("cli.options.extraArgs", { args: out.args.slice(max).join(" ") }), t("cli.options.extraArgsFix", { cmd }));
  return out;
}
