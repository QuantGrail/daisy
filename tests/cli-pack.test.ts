/**
 * P1-09: the installable package (scripts/pack-daisy.ts) — staged, never
 * published. The full `npm install -g` of the packed tgz needs the network
 * for its dependencies; it runs with DAISY_TEST_INSTALL=1 (and was run by
 * hand for the delivery, see docs/DELIVERY.md).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importsOf, pack, stage } from "../scripts/pack-daisy.ts";

test("Apache-2.0 — the full license text at the root, and every workspace package says so", () => {
  const root = join(import.meta.dirname, "..");
  const text = readFileSync(join(root, "LICENSE"), "utf8");
  assert.match(text, /Apache License\s+Version 2\.0, January 2004/);
  assert.match(text, /TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION/);
  assert.match(text, /END OF TERMS AND CONDITIONS/);
  assert.match(text, /^ {3}Copyright 2026 The Daisy Authors$/m);
  // P6-09: the NOTICE (Apache-2.0 §4(d)) names the same holder.
  assert.equal(readFileSync(join(root, "NOTICE"), "utf8"), "Daisy — Copyright 2026 The Daisy Authors\n");
  const rootPkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(rootPkg.license, "Apache-2.0", "package.json");
  const dirs: string[] = [];
  for (const w of rootPkg.workspaces as string[]) {
    if (!w.endsWith("/*")) dirs.push(w);
    else {
      const base = join(root, w.slice(0, -2));
      for (const n of readdirSync(base)) if (existsSync(join(base, n, "package.json"))) dirs.push(`${w.slice(0, -2)}/${n}`);
    }
  }
  assert.ok(dirs.includes("packages/a2a-mcp") && dirs.includes("packages/daisy"), dirs.join(","));
  for (const d of dirs) assert.equal(JSON.parse(readFileSync(join(root, d, "package.json"), "utf8")).license, "Apache-2.0", d);
});

test("importsOf: bare package names only (subpaths folded, node: and relative skipped)", () => {
  const src = `
    import { z } from "zod";
    import type { X } from "fastify";
    import Ajv from "ajv/dist/2020.js";
    import x from "@fastify/static";
    import "./local.ts";
    import { join } from "node:path";
    import fs from "fs";
    const m = await import("ws");
    require.resolve("@xterm/xterm");
    const s = "import a from \\"not a package\\"";
  `;
  assert.deepEqual(importsOf(src).sort(), ["@fastify/static", "@xterm/xterm", "ajv", "fastify", "ws", "zod"]);
});

test("the staged package: @daisy-ai/daisy, private (cannot be published), bin daisy, every import a dependency, no plugin package / tests / parked code", () => {
  const dir = mkdtempSync(join(tmpdir(), "daisy-stage-"));
  try {
    const pkg = stage(dir, { web: false });
    assert.equal(pkg.name, "@daisy-ai/daisy");
    assert.equal(pkg.private, true, "npm publish refuses a private package");
    // D-40 ⑤: Apache-2.0, and the license text goes in with the package.
    assert.equal(pkg.license, "Apache-2.0");
    assert.match(readFileSync(join(dir, "LICENSE"), "utf8"), /Apache License\s+Version 2\.0, January 2004/);
    assert.match(readFileSync(join(dir, "LICENSE"), "utf8"), /Copyright 2026 The Daisy Authors/);
    assert.match(readFileSync(join(dir, "NOTICE"), "utf8"), /Copyright 2026 The Daisy Authors/);
    // P6-09: where the source and the issues are (the planned public repository).
    assert.equal(pkg.author, "The Daisy Authors");
    assert.equal(pkg.repository.url, "git+https://github.com/QuantGrail/daisy.git");
    assert.match(pkg.bugs.url, /\/issues$/);
    assert.equal(pkg.bin.daisy, "packages/daisy/bin/daisy.mjs");
    // P5-06: it declares the start guard, so an update may switch to it.
    assert.equal(pkg.daisy.updateGuard, 1);
    assert.ok(existsSync(join(dir, "packages/daisy/src/update/guard.ts")));
    assert.ok(existsSync(join(dir, pkg.bin.daisy)));
    if (process.platform !== "win32")
      assert.ok(statSync(join(dir, pkg.bin.daisy)).mode & 0o100, "the bin is executable");
    assert.ok(pkg.dependencies.tsx, "tsx runs the TypeScript");
    for (const d of ["fastify", "zod", "ws", "jose", "@fastify/websocket"]) assert.ok(pkg.dependencies[d], d);
    assert.ok(!Object.keys(pkg.dependencies).some((d) => /react|expo|playwright|prettier|@daisy-ai\//.test(d)));
    assert.equal(pkg.engines.node, ">=24.0.0");
    assert.ok(existsSync(join(dir, "packages/daisy/src/main.ts")));
    assert.ok(existsSync(join(dir, "packages/daisy/src/turns/terminal-pty.py")), "non-TS assets come along");
    assert.ok(existsSync(join(dir, "packages/contracts/src/index.ts")));
    assert.ok(existsSync(join(dir, "packages/contracts/locales/en/cli.json")), "P6-20: the language packs");
    assert.ok(existsSync(join(dir, "packages/contracts/locales/zh-CN/cli.json")), "P6-20: the language packs");
    assert.ok(existsSync(join(dir, "packages/a2a-client/src/card.ts")), "P4-09: the shared A2A client and identity cards");
    assert.ok(existsSync(join(dir, "packages/relay/src/protocol.ts")), "P5-02: the relay protocol's constants (the relay link imports them)");
    assert.ok(!existsSync(join(dir, "packages/relay/src/relay.ts")), "P5-02: not the relay program itself (published on its own)");
    // I-5: no plugin package (one that runs inside Daisy: a peer dependency
    // on @daisy-ai/daisy) of this checkout goes in.
    for (const p of readdirSync("packages")) {
      const m = join("packages", p, "package.json");
      if (existsSync(m) && JSON.parse(readFileSync(m, "utf8")).peerDependencies?.["@daisy-ai/daisy"])
        assert.equal(existsSync(join(dir, "packages", p)), false, `I-5: no plugin package (${p}) in the package`);
    }
    // P4-13: a plugin installed as its own package reaches the core through this entry.
    assert.equal(pkg.exports["./plugin"], "./packages/daisy/src/plugins/api.ts");
    assert.ok(existsSync(join(dir, pkg.exports["./plugin"])));
    assert.ok(existsSync(join(dir, pkg.exports["."])));
    assert.equal(existsSync(join(dir, "tests")), false);
    assert.match(readFileSync(join(dir, ".release"), "utf8").trim(), /^\d+\.\d+\.\d+(\+[0-9a-f]+)?$/);
    assert.match(readFileSync(join(dir, pkg.bin.daisy), "utf8"), /^#!\/usr\/bin\/env node\r?\n/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("npm install -g of the packed tgz gives a working `daisy` (DAISY_TEST_INSTALL=1; needs the registry)", { skip: process.env.DAISY_TEST_INSTALL !== "1" }, () => {
  const root = mkdtempSync(join(tmpdir(), "daisy-install-"));
  try {
    const tgz = pack({ out: join(root, "out"), web: false });
    execFileSync("npm", ["install", "-g", "--prefix", join(root, "prefix"), "--no-audit", "--no-fund", tgz], { stdio: "ignore" });
    const bin = join(root, "prefix", process.platform === "win32" ? "daisy.cmd" : "bin/daisy");
    const v = execFileSync(bin, ["--version"], { encoding: "utf8" });
    assert.match(v, /^\d+\.\d+\.\d+ \(/);
    const dataDir = join(root, "data");
    const env = { ...process.env, DAISY_LOCAL_RUNNER: "0", DAISY_DATA: dataDir };
    execFileSync(bin, ["start"], { env, encoding: "utf8", cwd: root });
    try {
      const s = spawnSync(bin, ["status"], { env, encoding: "utf8", cwd: root });
      assert.equal(s.status, 0, s.stdout + s.stderr);
    } finally {
      execFileSync(bin, ["stop"], { env, encoding: "utf8", cwd: root });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
