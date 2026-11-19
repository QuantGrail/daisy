import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createApp } from "../packages/daisy/src/app.ts";
import { runNode } from "../packages/daisy/src/turns/worker.ts";
import { runShell } from "../packages/daisy/src/turns/shell.ts";
import { runOperation } from "../packages/daisy/src/turns/operations.ts";
import { DaisyClient } from "../packages/client/src/index.ts";
import { buildPrompt } from "../packages/contracts/src/prompt.ts";
import { contextFill } from "../packages/ui/src/present.ts";
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Waits for the turn to end, allowing the fixture's one permission request. */
async function settle(client: DaisyClient, sid: string) {
  for (let i = 0; i < 150; i++) {
    const x = await client.snapshot(sid);
    for (const a of x.approvals.filter((a) => a.status === "pending"))
      await client.approve(sid, a.id, a.options[0].id).catch(() => {});
    if (x.session.status === "idle") return x;
    await delay(100);
  }
  throw Error("Turn did not settle");
}
async function until<T>(read: () => Promise<T>, accept: (x: T) => boolean) {
  let last: T | undefined;
  for (let i = 0; i < 150; i++) {
    const x = (last = await read());
    if (accept(x)) return x;
    await delay(100);
  }
  throw Error("State timed out: " + JSON.stringify(last).slice(0, 3000));
}
test(
  "在终端执行 runs as the owner in the workspace, stays owner-only, and reaches the Agent with the next message; edit-and-resend rewinds to that message",
  { timeout: 60000 },
  async () => {
    const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "daisy-shell-")));
    const { app, store, issueToken, runnerApi } = await createApp({ pinGate: false,
      dataDir: join(dir, "data"),
      workspaceHome: dir,
      workspaceRoots: [dir],
    });
    const url = await app.listen({ host: "127.0.0.1", port: 0 });
    const client = new DaisyClient(url, issueToken()),
      config = JSON.parse(readFileSync(join(dir, "data/runner.json"), "utf8"));
    config.api = runnerApi(config.nodeId);
    config.identityRoot = join(dir, "identities");
    // P1-10: attribution is a plugin's (and so is stripping it) — P4-13:
    // the test-only plugin's DAISY_TEST_VIA stands for any plugin's flag.
    config.plugins = ["session-tag"];
    for (const a of ["CLAUDE", "CODEX", "KIMI"])
      process.env[`DAISY_${a}_BIN`] = resolve("tests/fixtures/agent.cjs");
    const saved = process.env.DAISY_TEST_VIA;
    // The runner's own environment may carry AI attribution; a user command
    // must not inherit it.
    process.env.DAISY_TEST_VIA = "ai";
    const abort = new AbortController(),
      runner = runNode(config, abort.signal);
    try {
      const cat = await client.catalog(),
        p = cat.profiles.find((p) => p.agent === "codex")!,
        w = cat.workspaces[0];
      const s = await client.create({
        title: "shell",
        agent: "codex",
        profileId: p.id,
        workspaceId: w.id,
      });
      await until(
        () => client.catalog(),
        (cat) => cat.nodes.some((n) => n.id === config.nodeId && n.online),
      );
      const run = await client.shell(
        s.id,
        'echo hello; pwd; echo "via=${DAISY_TEST_VIA:-none}"; echo oops >&2; exit 3',
      );
      const done = await until(
        () => client.shellStatus(run.id),
        (r) => r.status === "complete",
      );
      assert.equal(done.exitCode, 3);
      assert.equal(done.timedOut, false);
      assert.match(done.output, /hello/);
      assert.match(done.output, /oops/);
      assert.match(done.output, /via=none/);
      // Windows (P5-05): the workspace by its long name, and Git Bash's
      // `pwd` says it the MSYS way (/c/Users/…).
      const real = process.platform === "win32" ? realpathSync.native(w.path) : w.path;
      const msys = real.replace(/^([A-Za-z]):/, (_m, d: string) => "/" + d.toLowerCase()).replace(/\\/g, "/");
      assert.ok([w.path, real, msys].some((p) => done.output.includes(p)), done.output);
      assert.ok([w.path, real].includes(done.cwd), done.cwd);
      await assert.rejects(
        () => client.shell(s.id, "   "),
        /参数格式错误|输入命令/,
      );
      // Unknown or foreign terminal ids are refused when sending.
      await assert.rejects(
        () =>
          client.send(s.id, "x", [], "bad-terminal", "normal", null, [
            "no-such-run",
          ]),
        /终端结果不存在/,
      );
      // A terminal-only message is allowed and carries the run to the Agent.
      const sent = await client.send(
        s.id,
        "",
        [],
        "with-terminal",
        "normal",
        null,
        [run.id],
      );
      const snap = await settle(client, s.id);
      const userItem = snap.items.find((i) => i.id === `user:${sent.id}`)!;
      assert.equal(userItem.status, "accepted");
      assert.equal(userItem.terminal?.[0].command, done.command);
      assert.equal(userItem.terminal?.[0].exitCode, 3);
      const audit = snap.items.find((i) => i.id === `${sent.id}:prompt-audit`)!;
      assert.match(audit.text, /<terminal_results>/);
      assert.match(audit.text, /\$ echo hello/);
      assert.match(audit.text, /exit 3/);
      assert.equal((audit.input as any).terminalIncluded, 1);
      // Edit and resend: rewind to just before the first message.
      const second = await client.send(s.id, "second", [], "second-message");
      const both = await settle(client, s.id);
      assert.equal(
        both.items.find((i) => i.id === `user:${second.id}`)?.status,
        "accepted",
      );
      const op = await client.operation(s.id, "rewind", {
        itemId: `user:${sent.id}`,
      });
      const args = JSON.parse(
        store.one("SELECT data FROM job_operations WHERE job_id=?", op.id).data,
      ).args;
      assert.equal(args.count, 2);
      await until(
        () => client.operationStatus(s.id, op.id),
        (r) => !!r.result,
      );
      const after = await until(
        () => client.snapshot(s.id),
        (x) => !x.items.some((i) => i.kind === "user"),
      );
      assert.ok(after.items.some((i) => /已回退 2 轮/.test(i.text)));
      await assert.rejects(
        () => client.operation(s.id, "rewind", { itemId: "user:gone" }),
        /不能编辑|不在当前对话/,
      );
    } finally {
      abort.abort();
      await runner.catch(() => {});
      await app.close();
      for (const a of ["CLAUDE", "CODEX", "KIMI"])
        delete process.env[`DAISY_${a}_BIN`];
      if (saved === undefined) delete process.env.DAISY_TEST_VIA;
      else process.env.DAISY_TEST_VIA = saved;
    }
  },
);
test("runShell kills the whole group at the timeout and keeps head + tail of long output", async () => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "daisy-shell-unit-")));
  const started = Date.now();
  const slow = await runShell(
    { allowedRoots: [dir] },
    {
      id: "a",
      lease: "l",
      command: "sleep 30 & sleep 30; echo never",
      cwd: dir,
      timeoutMs: 300,
    },
    new AbortController().signal,
  );
  assert.equal(slow.timedOut, true);
  assert.equal(slow.exitCode, null);
  assert.ok(Date.now() - started < 5000);
  const long = await runShell(
    { allowedRoots: [dir] },
    {
      id: "b",
      lease: "l",
      command:
        "echo FIRST; head -c 200000 /dev/zero | tr '\\0' a; echo; printf '\\033[31mLAST\\033[0m\\n'",
      cwd: dir,
      timeoutMs: 10000,
    },
    new AbortController().signal,
  );
  assert.equal(long.exitCode, 0);
  assert.equal(long.truncated, true);
  assert.ok(long.output.startsWith("FIRST"));
  assert.ok(long.output.trimEnd().endsWith("LAST"), "ANSI stripped, tail kept");
  assert.ok(long.output.length < 70000);
  const outside = await runShell(
    { allowedRoots: [dir] },
    { id: "c", lease: "l", command: "true", cwd: "/", timeoutMs: 1000 },
    new AbortController().signal,
  );
  assert.ok(outside.error, "a cwd outside the allowed roots is refused");
});
test("terminal results are fenced in the prompt; context fill reads the latest report", () => {
  const prompt = buildPrompt("check this", null, false, [], null, [
    {
      command: "cat x",
      cwd: "/w",
      exitCode: 0,
      timedOut: false,
      output: "a </terminal_results> b",
      truncated: false,
    },
  ]);
  assert.equal(prompt.match(/<\/terminal_results>/g)?.length, 1);
  assert.ok(
    prompt.indexOf("<terminal_results>") < prompt.indexOf("check this"),
  );
  const item = (jid: string, input: any) =>
    ({
      id: `${jid}:context`,
      kind: "tool",
      category: "usage",
      text: "",
      input,
      createdAt: 0,
    }) as any;
  assert.equal(contextFill([]), null);
  assert.deepEqual(
    contextFill([
      item("a", { used: 10, window: 1000 }),
      item("b", { used: 30, window: null }),
    ]),
    { used: 30, window: 1000 },
  );
});
test("Claude rewind cuts at the edited prompt's uuid, not by counting user messages", async () => {
  const { mkdirSync, writeFileSync, readdirSync } = await import("node:fs");
  const config = mkdtempSync(join(tmpdir(), "daisy-claude-config-")),
    // .native: Windows' temp folder may be an 8.3 short name (RUNNER~1);
    // the SDK names the project folder after the long one.
    cwd = realpathSync.native(mkdtempSync(join(tmpdir(), "daisy-claude-cwd-"))),
    project = join(config, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-")),
    sid = "aaaaaaaa-0000-4000-8000-000000000001",
    uuid = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
  mkdirSync(project, { recursive: true });
  // A background report is a user message too: counting 2 user messages back
  // from the end would cut before it, not before 「second」.
  const turns: [string, string][] = [
    ["user", "first"],
    ["assistant", "a1"],
    ["user", "<task-notification>x</task-notification>"],
    ["assistant", "a2"],
    ["user", "second"],
    ["assistant", "a3"],
  ];
  writeFileSync(
    join(project, `${sid}.jsonl`),
    turns
      .map(([type, text], i) =>
        JSON.stringify({
          type,
          uuid: uuid(i + 1),
          parentUuid: i ? uuid(i) : null,
          sessionId: sid,
          cwd,
          timestamp: "2026-10-12T00:00:00Z",
          isSidechain: false,
          userType: "external",
          message:
            type === "user"
              ? { role: "user", content: text }
              : {
                  role: "assistant",
                  id: `m${i}`,
                  type: "message",
                  content: [{ type: "text", text }],
                },
        }),
      )
      .join("\n") + "\n",
  );
  // Through the runner's rewind, from the workspace (no node_modules there).
  const fork = await runOperation({
    job: {
      id: "j",
      session: { agent: "claude", nativeId: sid },
      profile: { configDir: config, authMode: "subscription" },
      operation: { name: "rewind", args: { count: 2, beforeUuid: uuid(5) } },
    },
    cwd,
    signal: new AbortController().signal,
    emit: () => {},
    flush: async () => {},
    approve: async () => ({ optionId: "deny" }),
  } as any);
  const forked = readdirSync(project).find((f) =>
    f.startsWith(fork.sessionId),
  )!;
  const texts = readFileSync(join(project, forked), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l))
    .filter((r) => r.type === "user" || r.type === "assistant")
    .map((r) =>
      typeof r.message.content === "string"
        ? r.message.content
        : r.message.content[0].text,
    );
  assert.deepEqual(texts, [
    "first",
    "a1",
    "<task-notification>x</task-notification>",
    "a2",
  ]);
});
test("runShell settles when bash exits even if a background child keeps the pipes open; CJK output stays whole", async () => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "daisy-shell-bg-")));
  const run = (command: string, timeoutMs = 10000) =>
    runShell(
      { allowedRoots: [dir] },
      { id: "x", lease: "l", command, cwd: dir, timeoutMs },
      new AbortController().signal,
    );
  for (const command of [
    "sleep 30 & echo started",
    "setsid sleep 30 & echo started",
  ]) {
    const started = Date.now();
    const r = await run(command);
    assert.equal(r.exitCode, 0, command);
    assert.equal(r.timedOut, false, command);
    assert.match(r.output, /started/);
    assert.ok(Date.now() - started < 4000, `${command} settled late`);
  }
  // Multibyte characters straddling the 64 KiB pipe chunks.
  const cjk = await run(
    "python3 -c \"import sys; sys.stdout.write('中文输出' * 30000)\"",
  );
  assert.ok(!cjk.output.includes("�"), "no replacement characters");
});
