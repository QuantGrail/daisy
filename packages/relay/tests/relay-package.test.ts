/**
 * P5-01 (ADR-143, ADR-103-3): the relay as a package — config, the
 * `daisy-relay` command, the bundle and what `npm pack` ships, the protocol
 * document matching the code, the log allow-list, per-address keys.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigError, DEFAULT_LIMITS, checkLimits, loadConfig } from "../src/config.ts";
import { makeLogger } from "../src/log.ts";
import { ipKey, plainIp, TokenBucket } from "../src/limits.ts";
import { ALERT, CLAIM_HEADER, CLOSE, PATHS, PROOF_TYP, subdomainOfIdentityId } from "../src/protocol.ts";
import { TestCA } from "./helpers/pki.ts";
import { TestDaisy, call } from "./helpers/daisy-side.ts";

const PKG = fileURLToPath(new URL("..", import.meta.url));
const ROOT = join(PKG, "..", "..");

test("config: file then environment; unknown keys, bad limits, bad domains refused", () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-cfg-"));
  try {
    const file = join(dir, "relay.json");
    writeFileSync(
      file,
      JSON.stringify({
        domain: "relay.test",
        listen: { port: 8443 },
        tls: { cert: "c.pem", key: "k.pem" },
        limits: { maxDaisys: 5 },
      }),
    );
    const c = loadConfig(file, {});
    assert.equal(c.domain, "relay.test");
    assert.deepEqual(c.listen, { host: "0.0.0.0", port: 8443 });
    assert.equal(c.limits.maxDaisys, 5);
    assert.equal(c.limits.claimTimeoutMs, DEFAULT_LIMITS.claimTimeoutMs);
    const e = loadConfig(file, {
      DAISY_RELAY_PORT: "9443",
      DAISY_RELAY_DOMAIN: "other.test",
      DAISY_RELAY_LOG_LEVEL: "warn",
    });
    assert.equal(e.listen.port, 9443);
    assert.equal(e.domain, "other.test");
    assert.equal(e.logLevel, "warn");
    // Only from the environment.
    const env = loadConfig(undefined, {
      DAISY_RELAY_DOMAIN: "relay.test",
      DAISY_RELAY_TLS_CERT: "c",
      DAISY_RELAY_TLS_KEY: "k",
    });
    assert.equal(env.listen.port, 443);

    const bad = (j: unknown, env: Record<string, string> = {}) => {
      writeFileSync(file, JSON.stringify(j));
      assert.throws(() => loadConfig(file, env), ConfigError, JSON.stringify(j));
    };
    const base = { domain: "relay.test", tls: { cert: "c", key: "k" } };
    bad({ ...base, extra: 1 });
    bad({ ...base, limits: { maxDaisy: 5 } });
    bad({ ...base, limits: { maxDaisys: 0 } });
    bad({ ...base, limits: { maxDaisys: 1.5 } });
    bad({ ...base, limits: { maxDaisys: "5" } });
    bad({ ...base, limits: { maxPendingPerDaisy: 10, maxStreamsPerDaisy: 5 } });
    bad({ ...base, domain: "Relay.Test" });
    bad({ ...base, domain: "localhost" });
    bad({ ...base, domain: "relay.test." });
    bad({ ...base, domain: "a".repeat(230) + ".test" });
    bad({ domain: "relay.test" });
    bad({ ...base, logLevel: "trace" });
    bad({ ...base, listen: { port: 70000 } });
    bad({ ...base, allowIdentities: [] });
    bad({ ...base, allowIdentities: ["not-an-id"] });
    bad({ ...base, limits: { maxUnclaimedData: 5 } }); // gone with review M1
    writeFileSync(
      file,
      JSON.stringify({
        ...base,
        allowIdentities: ["K7M2 Q6XD 4TFA 5WZE 3NPL 6HCV 2RYB 5SGU 7JKE 4MQA 7DXT 3WNF 6PZQ"],
      }),
    );
    assert.deepEqual(loadConfig(file, {}).allowIdentities, ["k7m2q6xd4tfa5wze3npl6hcv2ryb5sgu7jke4mqa7dxt3wnf6pzq"]);
    writeFileSync(file, "{not json");
    assert.throws(() => loadConfig(file, {}), ConfigError);
    assert.throws(() => loadConfig(join(dir, "missing.json"), {}), ConfigError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // Every default is a positive integer.
  for (const [k, v] of Object.entries(DEFAULT_LIMITS)) assert.ok(Number.isSafeInteger(v) && v > 0, k);
  assert.deepEqual(checkLimits(undefined), DEFAULT_LIMITS);
});

test("daisy-relay --check: the relay's certificate must cover its own name and must not be a wildcard", () => {
  const ca = new TestCA();
  const dir = mkdtempSync(join(tmpdir(), "relay-check-"));
  try {
    const run = (names: string[], args: string[] = [], env: Record<string, string> = {}) => {
      const leaf = ca.issue(names);
      writeFileSync(join(dir, "c.pem"), leaf.cert);
      writeFileSync(join(dir, "k.pem"), leaf.key);
      return spawnSync(process.execPath, ["--import", "tsx", join(PKG, "src", "bin.ts"), "--check", ...args], {
        cwd: ROOT,
        encoding: "utf8",
        env: {
          ...process.env,
          DAISY_RELAY_DOMAIN: "relay.test",
          DAISY_RELAY_TLS_CERT: join(dir, "c.pem"),
          DAISY_RELAY_TLS_KEY: join(dir, "k.pem"),
          ...env,
        },
      });
    };
    const ok = run(["relay.test"]);
    assert.equal(ok.status, 0, ok.stderr);
    const wild = run(["relay.test", "*.relay.test"]);
    assert.equal(wild.status, 2);
    assert.match(wild.stderr, /通配/);
    // P6-23b: the same refusal in English (--lang en, or DAISY_LANG=en).
    const wildEn = run(["relay.test", "*.relay.test"], ["--lang", "en"]);
    assert.equal(wildEn.status, 2);
    assert.match(wildEn.stderr, /the relay may only hold a certificate for exactly its own domain \(no wildcard/);
    const okEn = run(["relay.test"], [], { DAISY_LANG: "en" });
    assert.match(okEn.stdout, /^config OK: relay\.test, listening on 0\.0\.0\.0:443/);
    const wrong = run(["other.test"]);
    assert.equal(wrong.status, 2);
    const help = spawnSync(process.execPath, ["--import", "tsx", join(PKG, "src", "bin.ts"), "--help"], {
      cwd: ROOT,
      encoding: "utf8",
    });
    assert.equal(help.status, 0);
    assert.match(help.stdout, /daisy-relay/);
    const unknown = spawnSync(process.execPath, ["--import", "tsx", join(PKG, "src", "bin.ts"), "--nope"], {
      cwd: ROOT,
      encoding: "utf8",
    });
    assert.equal(unknown.status, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the bundled daisy-relay runs: a Daisy logs in, a call goes through, SIGTERM stops it", async (t) => {
  const out = join(PKG, "dist", `test-${process.pid}.mjs`);
  t.after(() => rmSync(out, { force: true }));
  const b = spawnSync(process.execPath, [join(PKG, "build.mjs"), "--outfile", out], { cwd: ROOT, encoding: "utf8" });
  assert.equal(b.status, 0, b.stderr);
  // Nothing of Daisy, the contracts beyond names.ts, or the shared client beyond identity is inside.
  const text = readFileSync(out, "utf8");
  assert.ok(!/packages\/daisy\//.test(text));
  assert.ok(!/from "zod"|require\("zod"\)/.test(text));
  assert.ok(text.startsWith("#!/usr/bin/env node"));
  // P6-23b (ADR-159 §10): every shipped language's relay pack is inside; no locale file is read.
  assert.doesNotMatch(text, /locales[\\/]|SHIPPED_LOCALES|dataDirLocales/);
  for (const k of ["relay.help", "relay.cli.checkOk"]) assert.equal(text.split(`"${k}":`).length - 1, 2, `${k}: en and zh-CN`);
  const en = spawnSync(process.execPath, [out, "--lang", "en", "--help"], { encoding: "utf8" });
  assert.match(en.stdout, /^Daisy Relay .*\(protocol v1\)\n\nUsage:/);
  const zh = spawnSync(process.execPath, [out, "--help"], { encoding: "utf8", env: { ...process.env, DAISY_LANG: "zh-CN" } });
  assert.match(zh.stdout, /用法：/);

  const ca = new TestCA();
  const leaf = ca.issue(["relay.test"]);
  const dir = mkdtempSync(join(tmpdir(), "relay-bin-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "c.pem"), leaf.cert);
  writeFileSync(join(dir, "k.pem"), leaf.key);
  writeFileSync(
    join(dir, "relay.json"),
    JSON.stringify({
      domain: "relay.test",
      listen: { host: "127.0.0.1", port: 0 },
      tls: { cert: join(dir, "c.pem"), key: join(dir, "k.pem") },
    }),
  );
  const child = spawn(process.execPath, [out, "--config", join(dir, "relay.json")], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => child.kill("SIGKILL"));
  const lines: string[] = [];
  const port = await new Promise<number>((resolve, reject) => {
    let buf = "";
    child.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        lines.push(line);
        const o = JSON.parse(line);
        if (o.ev === "relay.listening") resolve(o.port);
      }
    });
    child.once("exit", (c) => reject(new Error(`exited ${c}`)));
  });
  const d = new TestDaisy({ domain: "relay.test", port, ca: ca.cert, leaf: (sub) => ca.issue([`${sub}.relay.test`]) });
  t.after(() => d.stop());
  await d.start();
  const r = await call(port, d.host, ca.cert);
  assert.equal(r.status, 200);
  assert.equal(r.peerSpki, d.leaf.spki);
  const closed = new Promise<number>((res) => d.once("closed", res));
  const exited = new Promise<number | null>((res) => child.once("exit", (c) => res(c)));
  child.kill("SIGTERM");
  if (process.platform !== "win32") {
    assert.equal(await closed, CLOSE.restart);
    assert.equal(await exited, 0);
    assert.ok(lines.some((l) => JSON.parse(l).ev === "relay.stopped"));
  } else await exited;
  await d.stop();
  for (const l of lines) for (const k of Object.keys(JSON.parse(l))) assert.ok(k.length < 20);
});

test("npm pack ships the bundle, the protocol, the readme, the example config and the licence — nothing else", () => {
  const p = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: PKG,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  assert.equal(p.status, 0, p.stderr);
  const files = (JSON.parse(p.stdout)[0].files as { path: string }[]).map((f) => f.path).sort();
  const wanted = ["LICENSE", "NOTICE", "PROTOCOL.md", "README.md", "package.json", "relay.example.json"];
  // The bundle is there when it has been built (prepack builds it for a real pack).
  const built = existsSync(join(PKG, "dist", "daisy-relay.mjs"));
  assert.deepEqual(files, (built ? [...wanted, "dist/daisy-relay.mjs"] : wanted).sort());
  const pkg = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8"));
  assert.equal(pkg.bin["daisy-relay"], "dist/daisy-relay.mjs");
  assert.equal(pkg.license, "Apache-2.0");
  // The package's LICENSE and NOTICE are the repository's, word for word.
  for (const f of ["LICENSE", "NOTICE"]) assert.equal(readFileSync(join(PKG, f), "utf8"), readFileSync(join(ROOT, f), "utf8"), f);
  assert.equal(pkg.private, true, "not published without the owner (D-22)");
  assert.deepEqual(Object.keys(pkg.dependencies).sort(), ["jose", "ws"]);
});

test("the relay depends on no Daisy code; protocol.ts depends on nothing", () => {
  const src = join(PKG, "src");
  for (const f of readdirSync(src)) {
    const text = readFileSync(join(src, f), "utf8");
    const imports = [...text.matchAll(/from "([^"]+)"/g)].map((m) => m[1]!);
    for (const i of imports) {
      const ok =
        i.startsWith("node:") ||
        i.startsWith("./") ||
        i === "ws" ||
        i === "jose" ||
        i === "../../a2a-client/src/identity.ts" ||
        i === "../../contracts/src/names.ts" ||
        // P6-23b: the language packs (the bundle inlines them; no Daisy code).
        i === "../../contracts/src/i18n-process.ts";
      assert.ok(ok, `${f} imports ${i}`);
    }
    if (f === "protocol.ts") assert.deepEqual(imports, [], "protocol.ts must stay importable by the Daisy side as is");
  }
});

test("PROTOCOL.md says what the code does: version, paths, typ, close codes, alerts", () => {
  const doc = readFileSync(join(PKG, "PROTOCOL.md"), "utf8");
  assert.match(doc, /版本：\*\*1\*\*/);
  for (const p of [PATHS.control, PATHS.data, PATHS.presencePrefix, PATHS.info]) assert.ok(doc.includes(p), p);
  assert.ok(doc.includes(PROOF_TYP));
  assert.ok(doc.includes(CLAIM_HEADER), "the claim header");
  assert.match(doc, /修订记录/);
  for (const [name, code] of Object.entries(CLOSE))
    assert.ok(doc.includes(`| ${code} |`), `close code ${name} ${code}`);
  for (const [name, a] of Object.entries(ALERT)) assert.ok(doc.includes(`（${a}）`), `alert ${name} ${a}`);
  for (const k of Object.keys(DEFAULT_LIMITS).filter((k) =>
    /claimTimeoutMs|pingIntervalMs|maxControlMessageBytes|helloTimeoutMs/.test(k),
  ))
    assert.ok(doc.includes(k), k);
  assert.equal(
    subdomainOfIdentityId("k7m2 q6xd 4tfa 5wze 3npl 6hcv 2ryb 5sgu 7jke 4mqa 7dxt 3wnf 6pzq"),
    "k7m2q6xd4tfa5wze3npl6hcv2ryb5sgu",
  );
  assert.equal(subdomainOfIdentityId("too-short"), null);
});

test("logs: only allow-listed fields reach a line; levels filter", () => {
  const lines: string[] = [];
  const log = makeLogger("info", (l) => lines.push(l));
  log.debug("x.debug", { sub: "a" });
  log.info("x.info", { sub: "a", claim: "SECRET-CLAIM", nonce: "SECRET-NONCE", payload: "SECRET-BODY", n: 3 });
  assert.equal(lines.length, 1);
  const o = JSON.parse(lines[0]!);
  assert.deepEqual(Object.keys(o).sort(), ["ev", "lvl", "n", "sub", "ts"]);
  assert.ok(!lines[0]!.includes("SECRET"));
  assert.equal(log.dropped, 3);
});

test("per-address keys: IPv4 as is, IPv4-mapped unwrapped, IPv6 by /64; token buckets", () => {
  assert.equal(plainIp("::ffff:10.1.2.3"), "10.1.2.3");
  assert.equal(ipKey("10.1.2.3"), "10.1.2.3");
  assert.equal(ipKey("2001:db8:1:2:aaaa::1"), "2001:db8:1:2::/64");
  assert.equal(ipKey("2001:db8:1:2:bbbb:cccc:dddd:eeee"), "2001:db8:1:2::/64");
  assert.equal(ipKey("2001:db8::1"), "2001:db8:0:0::/64");
  assert.equal(ipKey("::1"), "0:0:0:0::/64");
  let now = 0;
  const b = new TokenBucket(2, 4, () => now);
  assert.ok(b.take(4));
  assert.ok(!b.take());
  now = 500;
  assert.ok(b.take());
  assert.ok(!b.take());
  assert.equal(b.reserve(4), 2000);
});
