/**
 * P4-13 (ADR-129): which plugin packages this checkout has. A test that
 * enables a plugin package (`plugins: ["<name>"]`, or imports its modules)
 * is that plugin's test and belongs in packages/<name>/tests; where a core
 * test still needs one, it is skipped without it, saying why — everything
 * else must pass with no plugin package installed (I-5).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..", "..");

/** Is packages/<name> here and its `@daisy-ai/<name>/server` entry resolvable? */
export function pluginInstalled(name: string): boolean {
  if (!existsSync(join(root, "packages", name, "package.json"))) return false;
  try {
    import.meta.resolve(`@daisy-ai/${name}/server`);
    return true;
  } catch {
    return false;
  }
}

/** `test(title, needsPlugin("x"), fn)` / `{ ...needsPlugin("x"), timeout }`. */
export function needsPlugin(name: string): { skip?: string } {
  return pluginInstalled(name) ? {} : { skip: `the plugin package @daisy-ai/${name} is not installed` };
}
