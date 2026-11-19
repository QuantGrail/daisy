// P1-10 (tests/plugin-seam.test.ts): log every module this process loads
// (URL per line, to PLUGIN_SEAM_LOAD_LOG), static and dynamic imports alike.
// P4-13: PLUGIN_SEAM_UNINSTALL=<name> — that plugin package is not installed
// here: resolving `@daisy-ai/<name>` (or any file of its directory) fails as
// a missing package does, and every attempt is logged (`blocked <specifier>`).
import { registerHooks } from "node:module";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, sep } from "node:path";

const log = process.env.PLUGIN_SEAM_LOAD_LOG;
const gone = process.env.PLUGIN_SEAM_UNINSTALL;
// A plugin package lives in packages/<name> or (test plugins) tests/plugins/<name>.
const repo = fileURLToPath(new URL("../..", import.meta.url));
const goneDirs = gone ? [join(repo, "packages", gone) + sep, join(repo, "tests", "plugins", gone) + sep] : [];
const inGone = (path) => goneDirs.some((d) => path.startsWith(d));
registerHooks({
  resolve(specifier, context, next) {
    if (gone) {
      const pkg = `@daisy-ai/${gone}`;
      const hit =
        specifier === pkg ||
        specifier.startsWith(pkg + "/") ||
        (specifier.startsWith("file:") && inGone(fileURLToPath(specifier))) ||
        (specifier.startsWith(".") &&
          context.parentURL?.startsWith("file:") &&
          inGone(fileURLToPath(new URL(specifier, context.parentURL))));
      if (hit) {
        if (log) appendFileSync(log, `blocked ${specifier}\n`);
        throw Object.assign(
          new Error(`Cannot find package '${pkg}' imported from ${context.parentURL ?? "?"}`),
          { code: "ERR_MODULE_NOT_FOUND" },
        );
      }
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (log) appendFileSync(log, url + "\n");
    return next(url, context);
  },
});
