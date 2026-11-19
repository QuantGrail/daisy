/**
 * P1-07: the commands the route table generates (ADR-107 §3) — table-driven
 * checks of argument parsing, positional arguments, --json, credentials
 * read from input (never the command line), the idempotency key the
 * command fills, the PIN flow and the mapping of errors to "what happened,
 * how to fix it".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  API_ROUTES,
  cliCommands,
  type CliCommandMeta,
} from "../packages/contracts/src/index.ts";
import { parseArgs } from "../packages/daisy/src/cli/table.ts";
import { TREE } from "../packages/daisy/src/cli/main.ts";
import { daisy, fakeDaisy, testIo } from "./cli-fixture.ts";
import { SelfIssuer } from "../packages/daisy/src/access/tokens/self-issuer.ts";
import { cardText, makeCard } from "../packages/daisy/src/contacts/card.ts";
import { translator as zhTranslator } from "../packages/contracts/src/i18n.ts";
import { shippedPacks as zhPacks } from "../packages/contracts/src/i18n-node.ts";
import { exemptText, routeText } from "../packages/contracts/src/api/route.ts";
/** P6-23a: the route table's text is in the packs; these assertions read the Chinese. */
const zh = zhTranslator(zhPacks(), "zh-CN");

const COMMANDS = cliCommands(API_ROUTES);
const byPath = (p: string) => {
  const c = COMMANDS.find((x) => x.path.join(" ") === p);
  assert.ok(c, `command ${p}`);
  return c!;
};
const ctx = (input: string[] = []) => ({ io: testIo({ input }), dataDir: "/nonexistent" });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test("every generated command answers --help from its definition, without Daisy running", async () => {
  for (const c of COMMANDS) {
    const io = testIo();
    const r = await daisy(io, "/nonexistent-daisy-data", ...c.path, "--help");
    assert.equal(r.code, 0, `${c.path.join(" ")}: ${r.err}`);
    assert.match(r.out, new RegExp(`接口：${c.method} ${c.httpPath.replace(/[/:]/g, "\\$&")}`));
    assert.ok(r.out.includes(routeText(c.route, "summary", zh)!), c.path.join(" "));
    if (c.pin) assert.match(r.out, /要输入 PIN/);
    if (c.idempotent) assert.match(r.out, /--idempotency-key/);
  }
});

test("a group prints its subcommands; an unknown word is an error that says what exists", async () => {
  for (const g of TREE.children.filter((n) => !n.command)) {
    const io = testIo();
    const r = await daisy(io, "/x", g.name);
    assert.equal(r.code, 0);
    assert.match(r.out, /子命令：/);
  }
  let io = testIo();
  let r = await daisy(io, "/x", "session", "sned", "a");
  assert.equal(r.code, 2);
  assert.match(r.err, /没有这个命令：daisy session sned/);
  assert.match(r.err, /是不是想用：send/);
  io = testIo();
  r = await daisy(io, "/x", "frobnicate");
  assert.equal(r.code, 2);
  assert.match(r.err, /怎么办：.*daisy --help/);
  // `login` is a group whose help walks through the sign-in.
  io = testIo();
  r = await daisy(io, "/x", "login");
  assert.match(r.out, /daisy login start <身份档 id>/);
  assert.match(r.out, /daisy profile create-managed/);
});

// ── parsing ─────────────────────────────────────────────────────────────

const cases: {
  cmd: string;
  argv: string[];
  params?: Record<string, string>;
  query?: Record<string, unknown>;
  body?: Record<string, unknown>;
  error?: RegExp;
}[] = [
  { cmd: "session send", argv: ["s1", "hello world"], params: { id: "s1" }, body: { text: "hello world" } },
  {
    cmd: "session send",
    argv: ["s1", "hi", "--delivery", "queue", "--attachment-ids", "a", "--attachment-ids=b"],
    body: { text: "hi", delivery: "queue", attachmentIds: ["a", "b"] },
  },
  { cmd: "session send", argv: ["s1", "hi", "--attachment-ids", '["x","y"]'], body: { text: "hi", attachmentIds: ["x", "y"] } },
  { cmd: "session send", argv: ["s1", "--", "--not-an-option"], body: { text: "--not-an-option" } },
  { cmd: "session send", argv: ["s1", "hi", "--delivery", "later"], error: /只能是 "normal"、"queue" 之一/ },
  { cmd: "session send", argv: ["s1"], error: /缺少参数 <text>/ },
  { cmd: "session send", argv: ["s1", "a", "b"], error: /多出来的参数/ },
  { cmd: "session send", argv: ["s1", "a", "--bogus"], error: /没有选项 --bogus/ },
  { cmd: "session send", argv: ["s1", "a", "--context", "{bad"], error: /要 JSON/ },
  { cmd: "session update", argv: ["s1", "--archived"], body: { archived: true } },
  { cmd: "session update", argv: ["s1", "--archived", "false"], body: { archived: false } },
  { cmd: "session update", argv: ["s1", "--no-archived"], body: { archived: false } },
  { cmd: "session update", argv: ["s1", "--archived=maybe"], error: /只能是 true 或 false/ },
  { cmd: "session events", argv: ["s1", "--after", "12"], query: { after: 12 } },
  { cmd: "session events", argv: ["s1", "--after", "x"], error: /要一个数/ },
  {
    cmd: "session create",
    argv: ["--agent", "codex", "--workspace-id", "w", "--profile-id", "p", "--json", '{"title":"T","agent":"claude"}'],
    body: { title: "T", agent: "codex", workspaceId: "w", profileId: "p" },
  },
  { cmd: "session create", argv: ["--agent", "codex", "--workspace-id", "w"], error: /缺少选项 --profile-id/ },
  { cmd: "session list", argv: ["--json", "{}"], error: /不带请求体/ },
  { cmd: "login input", argv: ["f1", "--code=abc"], error: /凭据，不能写在命令行里/ },
  { cmd: "login input", argv: ["f1", "--code", "abc"], error: /凭据，不能写在命令行里/ },
  { cmd: "login input", argv: ["f1", "--json", '{"code":"abc"}'], error: /凭据，不能写在命令行里/ },
  { cmd: "profile create", argv: ["--api-key=sk-1"], error: /凭据，不能写在命令行里/ },
  { cmd: "pin reset", argv: ["--confirm"], body: { confirm: true } },
  { cmd: "pin reset", argv: [], error: /缺少选项 --confirm/ },
  { cmd: "pin set", argv: ["--pin=123456"], error: /凭据，不能写在命令行里/ },
];

test("parsing: positional arguments, options, types, arrays, booleans, --json, refusals", async () => {
  for (const k of cases) {
    const c = byPath(k.cmd);
    const label = `${k.cmd} ${k.argv.join(" ")}`;
    if (k.error) {
      await assert.rejects(parseArgs(c, k.argv, ctx()), (e: any) => {
        assert.match(e.message, k.error!, label);
        assert.ok(e.fix, `${label}: an error says how to fix it`);
        assert.equal(e.exitCode, 2, label);
        return true;
      });
      continue;
    }
    const p = await parseArgs(c, k.argv, ctx());
    if (k.params) assert.deepEqual(p.params, k.params, label);
    if (k.query) assert.deepEqual(p.query, k.query, label);
    if (k.body) assert.deepEqual(p.body, k.body, label);
  }
});

test("--json for a body that is not an object (raw body), from argv, a file or standard input", async () => {
  const c: CliCommandMeta = {
    ...byPath("session send"),
    args: [byPath("session send").args[0]!],
    options: [],
    rawBody: true,
    idempotent: false,
  };
  await assert.rejects(parseArgs(c, ["s1"], ctx()), /--json 给出整个请求体/);
  assert.deepEqual((await parseArgs(c, ["s1", "--json", "[1,2]"], ctx())).body, [1, 2]);
  assert.deepEqual((await parseArgs(c, ["s1", "--json", "-"], ctx(['{"a":1}']))).body, { a: 1 });
});

test("a positional `-` reads the text from standard input", async () => {
  const p = await parseArgs(byPath("session send"), ["s1", "-"], ctx(["line one", "line two"]));
  assert.equal((p.body as any).text, "line one\nline two");
});

// ── against a stand-in Daisy ────────────────────────────────────────────

test("idempotency key: generated per run (a UUID), or the one given to resend", async () => {
  const d = await fakeDaisy();
  try {
    await daisy(testIo(), d.dataDir, "session", "send", "s1", "hi");
    await daisy(testIo(), d.dataDir, "session", "send", "s1", "hi");
    await daisy(testIo(), d.dataDir, "session", "send", "s1", "hi", "--idempotency-key", "k-1");
    const keys = d.requests.map((r) => r.body.requestId);
    assert.match(keys[0], UUID);
    assert.match(keys[1], UUID);
    assert.notEqual(keys[0], keys[1]);
    assert.equal(keys[2], "k-1");
    assert.equal(d.requests[0]!.path, "/api/sessions/s1/messages");
    // Every generated idempotent command fills its own key field.
    for (const c of COMMANDS.filter((x) => x.idempotent)) assert.ok(c.idempotencyKey, c.route);
    const term = COMMANDS.find((x) => x.route === "session.terminalInput")!;
    assert.equal(term.idempotencyKey, "id");
  } finally {
    await d.close();
  }
});

test("credentials come from input, never echo, never go anywhere but the request", async () => {
  const d = await fakeDaisy();
  try {
    const io = testIo({ input: ["auth-code-123"] });
    const r = await daisy(io, d.dataDir, "login", "input", "f1");
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(d.requests[0]!.body, { code: "auth-code-123" });
    assert.ok(!io.seen().includes("auth-code-123"));
    // An optional credential: the bare flag asks for it.
    const io2 = testIo({ input: ["sk-secret"] });
    await daisy(io2, d.dataDir, "profile", "create", "--label", "k", "--node-id", "n", "--agent", "claude", "--auth-mode", "apiKey", "--api-key");
    assert.equal(d.requests[1]!.body.apiKey, "sk-secret");
    assert.ok(!io2.seen().includes("sk-secret"));
    // Nothing more on standard input: says how to give it.
    const io3 = testIo({ input: [] });
    const r3 = await daisy(io3, d.dataDir, "login", "input", "f1");
    assert.equal(r3.code, 1);
    assert.match(r3.err, /标准输入里没有了/);
    assert.equal(d.requests.length, 2, "nothing sent without the credential");
  } finally {
    await d.close();
  }
});

test("a PIN-protected command asks for the PIN, trades it for a grant, sends the grant once; the PIN never shows", async () => {
  const d = await fakeDaisy((r) =>
    r.path === "/api/pin/grant"
      ? r.body.pin === "246810"
        ? { json: { grant: "g-xyz", expiresAt: Date.now() + 60_000 } }
        : { status: 403, json: { error: "PIN 不对", code: "pin_wrong" } }
      : undefined,
  );
  try {
    const keyDir = mkdtempSync(join(tmpdir(), "daisy-cli-card-"));
    const sampleCard = cardText(await makeCard(await SelfIssuer.open(keyDir), { name: "样例", addrs: [] }));
    rmSync(keyDir, { recursive: true, force: true });
    const pinRoutes = COMMANDS.filter((c) => c.pin);
    assert.ok(pinRoutes.length >= 1, "some table commands need the PIN");
    for (const c of pinRoutes) {
      const before = d.requests.length;
      const io = testIo({ input: ["246810", ...(c.args.map(() => "x"))] });
      // P4-01 review M-1: `contact import` reads the card before the PIN
      // (and stops on one that does not verify): give it a real one.
      const argv = [
        ...c.path,
        ...c.args.map((a) =>
          c.route === "grant.contactImport" && a.name === "card"
            ? sampleCard
            : /\bboolean\b/.test(a.type) // P4-06: `agent public set <id> on|off`
              ? "on"
              : ((a.enum?.[0] as string) ?? "x"),
        ),
      ];
      // Required options get a plausible value.
      for (const o of c.options.filter((o) => o.required && o.source === "value"))
        argv.push(o.flag!, (o.enum?.[0] as string) ?? "x");
      const r = await daisy(io, d.dataDir, ...argv);
      assert.equal(r.code, 0, `${c.path.join(" ")}: ${r.err}`);
      const sent = d.requests.slice(before);
      assert.equal(sent[0]!.path, "/api/pin/grant");
      assert.deepEqual(sent[0]!.body, { pin: "246810" });
      assert.equal(sent[1]!.headers["daisy-pin-grant"], "g-xyz", c.route);
      assert.ok(!io.seen().includes("246810") && !io.seen().includes("g-xyz"));
    }
    const io = testIo({ input: ["000000", "auto"] });
    const r = await daisy(io, d.dataDir, "access", "passcode", "auto");
    assert.equal(r.code, 1);
    assert.match(r.err, /PIN 不对[\s\S]*怎么办：.*再输一次/);
  } finally {
    await d.close();
  }
});

test("errors from Daisy become what happened + how to fix it", async () => {
  const answers: Record<string, { status: number; json: unknown }> = {
    "/api/sessions/a": { status: 404, json: { error: "会话不存在" } },
    "/api/sessions/b": { status: 500, json: { error: "服务内部错误，请检查服务日志" } },
    "/api/sessions/c": { status: 403, json: { error: "还没有设置 PIN", code: "pin_not_set" } },
    "/api/sessions/d": { status: 403, json: { error: "命令行不能做这项操作", code: "channel_not_allowed" } },
    "/api/sessions/e": { status: 400, json: { error: "参数格式错误", details: ["text 太长"] } },
    "/api/sessions/f": { status: 403, json: { error: "这个接口不在接口定义表里", code: "route_not_defined" } },
  };
  const d = await fakeDaisy((r) => answers[r.path]);
  try {
    const expect: [string, number, RegExp][] = [
      ["a", 1, /会话不存在[\s\S]*怎么办：找不到：id 写对了吗/],
      ["b", 1, /怎么办：Daisy 内部出错：看日志 .*logs[\\/]daisy\.log/],
      ["c", 1, /怎么办：还没有设置 PIN：先运行 daisy pin set/],
      ["d", 1, /怎么办：.*daisy open/],
      ["e", 2, /参数格式错误：text 太长[\s\S]*--help/],
      ["f", 1, /版本不一致/],
    ];
    for (const [id, code, re] of expect) {
      const io = testIo();
      const r = await daisy(io, d.dataDir, "session", "show", id);
      assert.equal(r.code, code, id);
      assert.match(r.err, re, id);
    }
    // Wrong credential.
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(d.dataDir, "keys", "cli-credential"), "dcli_wrong\n");
    const r = await daisy(testIo(), d.dataDir, "session", "list");
    assert.match(r.err, /怎么办：Daisy 不认这张本机凭据/);
  } finally {
    await d.close();
  }
});

test("Daisy not running: no runtime file, a dead process, or nothing listening — each says to start it", async () => {
  const d = await fakeDaisy();
  const rt = join(d.dataDir, "runtime.json");
  try {
    // Nothing listening (the process is there, the port is closed).
    const saved = readFileSync(rt, "utf8");
    const j = JSON.parse(saved);
    j.local.url = "http://127.0.0.1:9";
    const { writeFileSync } = await import("node:fs");
    writeFileSync(rt, JSON.stringify(j));
    let r = await daisy(testIo(), d.dataDir, "session", "send", "s1", "hi", "--idempotency-key", "k9");
    assert.equal(r.code, 3);
    assert.match(r.err, /连不上 Daisy[\s\S]*daisy start[\s\S]*--idempotency-key k9/);
    // A dead process.
    j.pid = 2 ** 22 + 12345;
    writeFileSync(rt, JSON.stringify(j));
    r = await daisy(testIo(), d.dataDir, "session", "list");
    assert.equal(r.code, 3);
    assert.match(r.err, /已经不在了[\s\S]*怎么办：先运行 daisy start/);
    rmSync(rt);
    r = await daisy(testIo(), d.dataDir, "whoami");
    assert.equal(r.code, 3);
    assert.match(r.err, /没有运行时文件[\s\S]*怎么办：先运行 daisy start/);
  } finally {
    await d.close();
  }
});

test("a download is saved with --output, refused onto a terminal, written to a pipe", async () => {
  const d = await fakeDaisy((r) =>
    r.path === "/api/attachments/a1" ? { bytes: new Uint8Array([1, 2, 3]) } : undefined,
  );
  try {
    const file = join(d.root, "out.bin");
    let io = testIo();
    let r = await daisy(io, d.dataDir, "attachment", "download", "a1", "--output", file);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual([...readFileSync(file)], [1, 2, 3]);
    io = testIo({ stdoutTTY: true });
    r = await daisy(io, d.dataDir, "attachment", "download", "a1");
    assert.equal(r.code, 1);
    assert.match(r.err, /--output/);
    io = testIo();
    r = await daisy(io, d.dataDir, "attachment", "download", "a1");
    assert.deepEqual([...io.bytes[0]!], [1, 2, 3]);
    assert.ok(existsSync(file));
  } finally {
    await d.close();
  }
});

test("a file option sends the file's content (base64)", async () => {
  const d = await fakeDaisy();
  try {
    const { writeFileSync } = await import("node:fs");
    const file = join(d.root, "note.txt");
    writeFileSync(file, "hello");
    const c = COMMANDS.find((x) => x.options.some((o) => o.source === "file"))!;
    const f = c.options.find((o) => o.source === "file")!;
    const argv = [...c.path, f.flag!, file];
    for (const o of c.options.filter((o) => o.required && o !== f)) argv.push(o.flag!, "x");
    const r = await daisy(testIo(), d.dataDir, ...argv);
    assert.equal(r.code, 0, r.err);
    assert.equal(d.requests[0]!.body[f.name], Buffer.from("hello").toString("base64"));
  } finally {
    await d.close();
  }
});

test("pin set: typed twice; a mismatch sends nothing; the old PIN is asked for when Daisy wants it", async () => {
  const pinSet = COMMANDS.find((c) => c.route === "settings.pinSet");
  if (!pinSet) return; // P1-05's routes are not on this branch yet.
  const d = await fakeDaisy((r) =>
    r.path === "/api/pin" && r.method === "POST" && !r.body.oldPin
      ? { status: 400, json: { error: "已经设置过 PIN，要带旧 PIN", code: "pin_old_required" } }
      : undefined,
  );
  try {
    let r = await daisy(testIo({ input: ["123456", "654321"] }), d.dataDir, "pin", "set");
    assert.equal(r.code, 1);
    assert.match(r.err, /两次输入的不一样/);
    assert.equal(d.requests.length, 0);
    r = await daisy(testIo({ input: ["123456", "123456", "111111"] }), d.dataDir, "pin", "set");
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(d.requests.at(-1)!.body, { pin: "123456", oldPin: "111111" });
  } finally {
    await d.close();
  }
});

test("pin status / reset (P1-05's routes, generated): the right requests; reset needs --confirm and no PIN; status needs nothing typed", async () => {
  const d = await fakeDaisy((r) => (r.path === "/api/pin" && r.method === "GET" ? { json: { set: true, lockedUntil: null } } : undefined));
  try {
    let io = testIo();
    let r = await daisy(io, d.dataDir, "pin", "status");
    assert.equal(r.code, 0, r.err);
    assert.equal(JSON.parse(r.out).set, true);
    io = testIo();
    r = await daisy(io, d.dataDir, "pin", "reset", "--confirm");
    assert.equal(r.code, 0, r.err);
    const sent = d.requests.at(-1)!;
    assert.equal(sent.method, "POST");
    assert.equal(sent.path, "/api/pin/reset");
    assert.deepEqual(sent.body, { confirm: true });
    assert.equal(sent.headers["daisy-pin-grant"], undefined, "resetting is local, not 「放别人进来」");
    assert.ok(!d.requests.some((x) => x.path === "/api/pin/grant"));
    const reset = COMMANDS.find((c) => c.route === "settings.pinReset")!;
    assert.deepEqual([...reset.channels], ["cli"], "only the command line can reset");
  } finally {
    await d.close();
  }
});

