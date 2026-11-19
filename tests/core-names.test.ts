import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-ignore — a plain .mjs script (scripts/check-core-names.mjs)
import { loadRules, scan } from "../scripts/check-core-names.mjs";
/**
 * P4-13 (plan 3.6, I-5), generalized by P6-00 (ADR-150): the core names no
 * plugin. The check the CI's Linux job runs (scripts/check-core-names.mjs),
 * also run here so the local gate has it.
 */
test("P4-13: the core (daisy, contracts, ui, client, app shell, relay) names no plugin", () => {
  const { hits, stale } = scan();
  assert.deepEqual(
    hits.map((h: any) => `${h.file}:${h.line}: ${h.text}`),
    [],
    "move it behind the plugin seam (the plugin's own package) or word it generically",
  );
  assert.deepEqual(stale, [], "an exemption that matches nothing must be removed");
  const { rules, allowed, plugins } = loadRules();
  // The test plugin is always here, so the check always has a name to look for.
  assert.ok(plugins.includes("@daisy-ai/session-tag"), plugins.join(", "));
  assert.ok(rules.length >= plugins.length);
  // The exemption list stays small and says why.
  assert.ok(allowed.length <= 3);
  for (const a of allowed) assert.ok(a.why.length > 40, a.file);
});

test("P6-00: the names come from the plugin packages in the tree and the private manifest — any case, any file kind", () => {
  const dir = mkdtempSync(join(tmpdir(), "daisy-core-names-"));
  try {
    mkdirSync(join(dir, "packages/daisy/src"), { recursive: true });
    mkdirSync(join(dir, "packages/ui/src/node_modules/x"), { recursive: true });
    // A plugin package in the tree: found by its exports.
    mkdirSync(join(dir, "packages/acme"), { recursive: true });
    writeFileSync(
      join(dir, "packages/acme/package.json"),
      JSON.stringify({ name: "@daisy-ai/acme", exports: { "./server": "./src/server.ts" } }),
    );
    // A package that is no plugin is not a name to avoid.
    mkdirSync(join(dir, "packages/lib"), { recursive: true });
    writeFileSync(join(dir, "packages/lib/package.json"), JSON.stringify({ name: "@daisy-ai/lib" }));
    // A private plugin, named only in the private manifest, with its own patterns and exemption.
    mkdirSync(join(dir, "scripts/private"), { recursive: true });
    writeFileSync(
      join(dir, "scripts/private/public-manifest.json"),
      JSON.stringify({
        privatePlugins: [
          {
            package: "@daisy-ai/zephyr",
            forbidden: [
              { name: "zephyr", re: "zephyr", flags: "i" },
              { name: "zephyr ids", re: "\\bZPH-[0-9a-f]{6,}" },
            ],
            allowedInCore: [{ file: "packages/daisy/src/a.ts", text: "// frozen: zephyr", why: "x".repeat(41) }],
          },
        ],
      }),
    );
    writeFileSync(
      join(dir, "packages/daisy/src/a.ts"),
      [
        'import x from "@daisy-ai/acme/server";',
        "const ok = 1;",
        'run("ACME get x --raw");',
        "const lib = 'lib';",
        "process.env.DAISY_ZEPHYR_SOCKET;",
        'const t = "ZPH-0123456789ab";',
        "// frozen: zephyr",
        "const acmeish = 'acme-corp-tool';",
      ].join("\n"),
    );
    writeFileSync(join(dir, "packages/daisy/src/b.md"), "ZePhYr UI\n");
    // Installed packages are not the core's code.
    writeFileSync(join(dir, "packages/ui/src/node_modules/x/c.js"), "zephyr acme\n");
    const loaded = loadRules(dir);
    assert.deepEqual(loaded.plugins.sort(), ["@daisy-ai/acme", "@daisy-ai/zephyr"]);
    const { hits, stale } = scan(dir, ["packages/daisy", "packages/ui"], loaded);
    assert.deepEqual(
      hits.map((h: any) => `${h.file}:${h.line}`),
      [
        "packages/daisy/src/a.ts:1",
        "packages/daisy/src/a.ts:3",
        "packages/daisy/src/a.ts:5",
        "packages/daisy/src/a.ts:6",
        "packages/daisy/src/b.md:1",
      ],
    );
    assert.deepEqual(stale, []);
    // Without the private manifest (the public tree), the plugins in the tree still count.
    rmSync(join(dir, "scripts"), { recursive: true });
    const pub = loadRules(dir);
    assert.deepEqual(pub.plugins, ["@daisy-ai/acme"]);
    assert.deepEqual(
      scan(dir, ["packages/daisy"], pub).hits.map((h: any) => h.line),
      [1, 3],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
