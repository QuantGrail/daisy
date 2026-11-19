/**
 * P6-09: every file under examples/ is checked against Daisy's own code —
 * no network, no real harness, no real domain:
 *
 * - acp-harness: the JSON file through the real loader (`acpHarnessFromJson`,
 *   and a child process started with `DAISY_ACP_HARNESSES` pointing at it);
 * - relay: relay.json through the relay's config loader and `daisy-relay
 *   --check` (a test certificate for the example's domain); the systemd
 *   unit's command line and signals match what the relay takes;
 * - a2a-client: both examples against a real Daisy in this process
 *   (temporary port, the fake harness), call and answer;
 * - daisy-mcp: each MCP client config starts `daisy-mcp` (from source) and
 *   an MCP client lists its three tools;
 * - plugin-hello: loaded by name through the plugin seam's own loader.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import TOML from "@iarna/toml";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { acpHarnessFromJson } from "../packages/contracts/src/acp-harnesses.ts";
import { loadConfig } from "../packages/relay/src/config.ts";
import { TestCA } from "../packages/relay/tests/helpers/pki.ts";
import { readCard } from "../packages/a2a-client/src/index.ts";
import type { A2AJob, A2AOutcome } from "../packages/daisy/src/a2a/executors.ts";
import { createApp } from "../packages/daisy/src/app.ts";
import {
  activateRunnerPlugins,
  loadRunnerPlugins,
  pluginEnvKeys,
  pluginSelection,
  pluginSessionEnv,
} from "../packages/daisy/src/plugins/runner.ts";
import { loadServerPlugins } from "../packages/daisy/src/plugins/server.ts";
import { kindInLanguage } from "../packages/contracts/src/notifications.ts";
import { translator } from "../packages/contracts/src/i18n.ts";
import { loadPacks } from "../packages/contracts/src/i18n-node.ts";
import { ScriptIdentity, callAgent, pinStore } from "../examples/a2a-client/call-agent.ts";
import { askWithSdk } from "../examples/a2a-client/official-sdk.ts";
import { a2aNode, fixtureCli } from "./fixtures/a2a-node.ts";

const root = resolve(import.meta.dirname, "..");
const EX = join(root, "examples");
const POSIX = process.platform !== "win32";
const scratch = mkdtempSync(join(tmpdir(), "daisy-examples-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

test("examples: every directory has a README; no real domain, address or credential anywhere", () => {
  const dirs = readdirSync(EX).filter((n) => statSync(join(EX, n)).isDirectory());
  assert.deepEqual(dirs.sort(), ["a2a-client", "acp-harness", "daisy-mcp", "plugin-hello", "relay"]);
  const files: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else files.push(p);
    }
  };
  walk(EX);
  for (const d of dirs) assert.ok(files.includes(join(EX, d, "README.md")), d);
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    // Host names: only the reserved example domains (and the few public ones a reader needs).
    for (const m of text.matchAll(/\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|dev|cn|ai)\b/gi)) {
      const host = m[0].toLowerCase();
      assert.ok(
        /(^|\.)example\.(com|net)$/.test(host) || host === "github.com" || /^[\w-]+\.(ts|md|json|mjs|js)$/.test(host),
        `${f}: ${host}`,
      );
    }
    for (const m of text.matchAll(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g))
      assert.ok(/^(203\.0\.113\.|127\.|0\.0\.0\.0)/.test(m[0]), `${f}: ${m[0]}`);
    assert.doesNotMatch(text, /BEGIN [A-Z ]*PRIVATE KEY|"d"\s*:\s*"[A-Za-z0-9_-]{20,}"|sk-[A-Za-z0-9]{10,}/, f);
  }
});

// ── acp-harness ─────────────────────────────────────────────────────────

test("acp-harness: the example file loads through DAISY_ACP_HARNESSES — a new agent value, its command, its name", () => {
  const file = join(EX, "acp-harness", "acp-harnesses.json");
  const list = JSON.parse(readFileSync(file, "utf8"));
  assert.ok(Array.isArray(list) && list.length >= 1);
  for (const x of list) {
    const h = acpHarnessFromJson(x);
    assert.equal(h.id, x.id);
    assert.equal(h.launch.command, x.launch.command);
  }
  // The real path: a process whose environment names the file.
  const probe = `
    const m = await import(${JSON.stringify(pathToFileURL(join(root, "packages/contracts/src/acp-harnesses.ts")).href)});
    const s = await import(${JSON.stringify(pathToFileURL(join(root, "packages/contracts/src/session.ts")).href)});
    const h = m.acpHarness("gemini");
    console.log(JSON.stringify({ agents: m.AGENT_IDS, parsed: s.AgentSchema.parse("gemini"), name: m.agentName("gemini"),
      command: m.agentCommand("gemini", {}), args: h.launch.args, tier: h.tier, readOnly: m.readOnlySupport("gemini") }));`;
  const r = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", probe], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, DAISY_ACP_HARNESSES: file },
  });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim().split("\n").pop()!);
  assert.deepEqual(out.agents.slice(-1), ["gemini"]);
  assert.equal(out.parsed, "gemini");
  assert.equal(out.name, "Gemini CLI");
  assert.equal(out.command, "gemini");
  assert.deepEqual(out.args, ["--experimental-acp"]);
  assert.equal(out.tier, "experimental");
  // No modes declared: no read-only, takes no 「问」 (the README says so).
  assert.equal(out.readOnly, "none");
  const readme = readFileSync(join(EX, "acp-harness", "README.md"), "utf8");
  assert.match(readme, /DAISY_ACP_HARNESSES=/);
  // P6-11: the way that also reaches a Daisy started at boot.
  assert.match(readme, /"acpHarnesses": "acp-harnesses\.json"/);
  assert.match(readme, /profile create --agent gemini --auth-mode subscription/);
});

// ── relay ───────────────────────────────────────────────────────────────

test("relay: relay.json loads through the relay's own loader, and daisy-relay --check accepts it with a certificate for exactly its domain", () => {
  const file = join(EX, "relay", "relay.json");
  const cfg = loadConfig(file, {});
  assert.equal(cfg.domain, "relay.example.com");
  assert.deepEqual(cfg.listen, { host: "0.0.0.0", port: 443 });
  assert.equal(cfg.limits.maxDaisys, 1000);
  const dir = mkdtempSync(join(scratch, "relay-"));
  const leaf = new TestCA().issue([cfg.domain]);
  writeFileSync(join(dir, "c.pem"), leaf.cert);
  writeFileSync(join(dir, "k.pem"), leaf.key);
  const r = spawnSync(process.execPath, ["--import", "tsx", join(root, "packages/relay/src/bin.ts"), "--config", file, "--check"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, DAISY_RELAY_TLS_CERT: join(dir, "c.pem"), DAISY_RELAY_TLS_KEY: join(dir, "k.pem") },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /relay\.example\.com，监听 0\.0\.0\.0:443/);
  // The README's paths are the config's.
  const readme = readFileSync(join(EX, "relay", "README.md"), "utf8");
  for (const p of [cfg.tls.cert, cfg.tls.key, "/etc/daisy-relay/relay.json"]) assert.ok(readme.includes(p.replace("relay.example.com", "$d")) || readme.includes(p), p);
});

test("relay: the systemd unit runs `daisy-relay --config <file>` (checked first), reloads with SIGHUP, binds 443 without root", () => {
  const unit = readFileSync(join(EX, "relay", "daisy-relay.service"), "utf8");
  const kv = (k: string) => [...unit.matchAll(new RegExp(`^${k}=(.*)$`, "gm"))].map((m) => m[1]!.trim());
  const [start] = kv("ExecStart");
  const words = start!.split(/\s+/);
  assert.match(words[0]!, /\/daisy-relay$/);
  assert.deepEqual(words.slice(1), ["--config", "/etc/daisy-relay/relay.json"]);
  assert.deepEqual(kv("ExecStartPre")[0]!.split(/\s+/).slice(1), ["--config", "/etc/daisy-relay/relay.json", "--check"]);
  assert.match(kv("ExecReload")[0]!, /kill -HUP \$MAINPID/);
  assert.deepEqual(kv("AmbientCapabilities"), ["CAP_NET_BIND_SERVICE"]);
  assert.deepEqual(kv("CapabilityBoundingSet"), ["CAP_NET_BIND_SERVICE"]);
  assert.deepEqual(kv("User"), ["daisy-relay"]);
  assert.deepEqual(kv("NoNewPrivileges"), ["true"]);
  // The relay's main takes exactly these flags; SIGHUP / SIGTERM are what it handles.
  const main = readFileSync(join(root, "packages/relay/src/main.ts"), "utf8");
  assert.match(main, /"--check"/);
  assert.match(main, /"--config"/);
  assert.match(main, /process\.on\("SIGHUP"/);
  assert.match(main, /process\.once\("SIGTERM"/);
});

// ── a2a-client ──────────────────────────────────────────────────────────

test("a2a-client: call-agent.ts and the official SDK call an agent on a real Daisy (in process) — answer, a question and its reply", { timeout: 120_000 }, async () => {
  const cli = fixtureCli(scratch);
  const daisy = await a2aNode("Dave");
  try {
    const agent = await daisy.session("Dave 的研究助手");
    const jobs: A2AJob[] = [];
    daisy.publish(() => [agent.id], {
      run: async (job: A2AJob): Promise<A2AOutcome> => {
        jobs.push(job);
        if (job.text.startsWith("ask") && !job.continuing) return { state: "input-required", question: "要哪个城市的？" };
        return { state: "completed", answer: `Dave 的回答：${job.text}` };
      },
    });
    // The script's identity: made on first use, only its owner may read the key.
    const keyFile = join(scratch, "me.key.json");
    const self = ScriptIdentity.open(keyFile);
    if (POSIX) assert.equal(statSync(keyFile).mode & 0o777, 0o600);
    assert.equal(ScriptIdentity.open(keyFile).forms.id, self.forms.id, "the same key the second time");
    // The owner imports the script's card (whitelisted); the script reads Dave's.
    await daisy.importCard(await self.card("示例脚本"), true);
    const daisyCard = await daisy.card();
    const contact = await readCard(daisyCard.text);
    const policy = { allowLoopback: true };

    const r = await callAgent({ self, contact, text: "你好", policy });
    assert.equal(r.state, "TASK_STATE_COMPLETED");
    assert.equal(r.agentId, agent.id);
    assert.match(r.text, /Dave 的回答：你好/);

    const q = await callAgent({ self, contact, text: "ask 天气", policy });
    assert.equal(q.state, "TASK_STATE_INPUT_REQUIRED");
    assert.match(q.text, /要哪个城市/);
    const a = await callAgent({ self, contact, text: "北京", taskId: q.taskId!, contextId: q.contextId!, policy });
    assert.equal(a.state, "TASK_STATE_COMPLETED");
    assert.equal(a.taskId, q.taskId);

    // A certificate pinned on first use, refused when it changes.
    const pins = pinStore(join(scratch, "pins.json"));
    const seen = { origin: "https://dave.example.net:29600", fingerprint: "aa", authorized: false, spki: "x" };
    assert.equal(pins(contact.id, seen), true);
    assert.equal(pinStore(join(scratch, "pins.json"))(contact.id, seen), true);
    assert.match(String(pinStore(join(scratch, "pins.json"))(contact.id, { ...seen, fingerprint: "bb" })), /不一样/);

    // The official SDK, both transports.
    for (const binding of ["JSONRPC", "HTTP+JSON"] as const) {
      const s = await askWithSdk({ self, aud: contact.urn, agentUrl: `${daisy.url}/a2a/${agent.id}/`, text: `sdk ${binding}`, binding });
      assert.equal(s.state, "TASK_STATE_COMPLETED", binding);
      assert.match(s.text, new RegExp(`Dave 的回答：sdk ${binding.replace("+", "\\+")}`));
    }
    assert.equal(jobs.length, 5);

    // The command line: `card` prints a card Daisy can read; `call` keeps the production rules (no loopback).
    const tsx = (args: string[]) =>
      spawnSync(process.execPath, ["--import", "tsx", join(EX, "a2a-client", "call-agent.ts"), ...args], { cwd: root, encoding: "utf8" });
    const card = tsx(["card", "--key", keyFile, "--name", "示例脚本"]);
    assert.equal(card.status, 0, card.stderr);
    assert.equal((await readCard(card.stdout)).id, self.forms.id);
    writeFileSync(join(scratch, "dave.daisycard"), daisyCard.text);
    const call = tsx(["call", "--key", keyFile, "--card", join(scratch, "dave.daisycard"), "你好"]);
    assert.equal(call.status, 1);
    assert.match(call.stderr, /不连本机回环地址/);
    assert.equal(jobs.length, 5, "nothing reached Daisy");
  } finally {
    await daisy.close();
    cli.close();
  }
});

// ── daisy-mcp ───────────────────────────────────────────────────────────

test("daisy-mcp: both client configs start the server (daisy-mcp serve …) and an MCP client sees its three tools", { timeout: 60_000 }, async () => {
  const claude = JSON.parse(readFileSync(join(EX, "daisy-mcp", "claude-code.mcp.json"), "utf8")).mcpServers.daisy;
  const codex = (TOML.parse(readFileSync(join(EX, "daisy-mcp", "codex.config.toml"), "utf8")) as any).mcp_servers.daisy;
  // The client starts it with only the default environment (no LANG / DAISY_LANG): daisy-mcp
  // then speaks the system's language. Each config is run in one language, named here.
  for (const [name, c, lang, empty] of [
    ["claude", claude, "zh-CN", /通讯录是空的/],
    ["codex", codex, "en", /The address book is empty/],
  ] as const) {
    assert.equal(c.command, "daisy-mcp", name);
    assert.equal(c.args[0], "serve", name);
    const home = mkdtempSync(join(scratch, `mcp-${name}-`));
    // `daisy-mcp` is the package's bin; here from source.
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", join(root, "packages/a2a-mcp/src/bin.ts"), ...c.args, "--home", home],
      cwd: root,
      env: { ...getDefaultEnvironment(), DAISY_LANG: lang },
      stderr: "pipe",
    });
    const client = new Client({ name: "examples-test", version: "0.0.0" });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      assert.deepEqual(tools.map((t) => t.name).sort(), ["agents", "call_agent", "call_result"], name);
      const r = (await client.callTool({ name: "agents", arguments: {} })) as { content: { text: string }[] };
      assert.match(r.content[0]!.text, empty, name);
    } finally {
      await client.close();
    }
  }
});

// ── plugin-hello ────────────────────────────────────────────────────────

test("plugin-hello: loaded by name through the seam (as if installed as @daisy-ai/example-hello) — both halves, the env it adds, a Daisy that starts with it", async () => {
  const PKG = "@daisy-ai/example-hello";
  const pkgJson = JSON.parse(readFileSync(join(EX, "plugin-hello", "package.json"), "utf8"));
  assert.equal(pkgJson.name, PKG);
  // Installed the way its README says (a link in the checkout's
  // node_modules): P6-16 review L1 — Daisy takes a plugin only from where it
  // is installed, so a resolve hook alone is not "installed" any more.
  const link = join(EX, "..", "node_modules", "@daisy-ai", "example-hello");
  let made = false;
  try {
    lstatSync(link);
  } catch {
    if (process.platform === "win32") symlinkSync(join(EX, "plugin-hello"), link, "junction");
    else symlinkSync(join("..", "..", "examples", "plugin-hello"), link, "dir");
    made = true;
  }
  after(() => {
    if (made) rmSync(link, { force: true });
  });
  assert.deepEqual([...pluginSelection(["example-hello"]).keys()], ["example-hello"]);
  const server = await loadServerPlugins(["example-hello"], { store: {} as any });
  assert.deepEqual(server.names, ["example-hello"]);
  // P6-28: its notification kind, declared in English and Chinese, said in the reader's language.
  const hello = server.notificationKinds.find((k) => k.id === "hello_ping")!;
  const say = (lang: string) => kindInLanguage(hello, translator(loadPacks().packs, lang));
  assert.deepEqual(say("en"), { id: "hello_ping", label: "Greeting", hint: "The example plugin's greeting" });
  assert.deepEqual(say("zh-CN"), { id: "hello_ping", label: "问候", hint: "例子插件的问候" });
  const list = await loadRunnerPlugins(new Map([["example-hello", { greeting: "你好" }]]), {
    api: async () => ({}),
    stateRoot: scratch,
    stateKey: "k",
    user: "me",
    log: () => {},
  });
  const off = activateRunnerPlugins(list);
  try {
    assert.deepEqual(pluginSessionEnv({ id: "s-1", agent: "codex" }), {
      HELLO_SESSION: "s-1",
      HELLO_AGENT: "codex",
      HELLO_GREETING: "你好",
    });
    assert.deepEqual(pluginEnvKeys().sort(), ["HELLO_AGENT", "HELLO_GREETING", "HELLO_SESSION"]);
  } finally {
    off();
  }
  const dir = mkdtempSync(join(scratch, "plugin-"));
  const ctx = await createApp({ pinGate: false, dataDir: dir, bootstrap: false, plugins: ["example-hello"] });
  await ctx.app.close();
});
