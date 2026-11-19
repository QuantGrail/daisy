import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve, join } from "node:path";
import {
  mkdtempSync,
  symlinkSync,
  mkdirSync,
  rmSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { runClaude } from "../packages/daisy/src/harness/claude.ts";
import {
  codexApprovalOptions,
  codexDecisionLabel,
  runCodex,
} from "../packages/daisy/src/harness/codex.ts";
import { runKimi } from "../packages/daisy/src/harness/kimi.ts";
import {
  safeWorkspace,
  agentEnv,
  type Runtime,
} from "../packages/daisy/src/harness/shared.ts";
for (const [agent, run] of Object.entries({
  claude: runClaude,
  codex: runCodex,
  kimi: runKimi,
}))
  test(`${agent}: streaming, native session and approval protocol`, async () => {
    process.env[`DAISY_${agent.toUpperCase()}_BIN`] = resolve(
      "tests/fixtures/agent.cjs",
    );
    const events: any[] = [],
      requests: any[] = [];
    const rt: Runtime = {
      job: {
        id: "job1",
        session: { agent, nativeId: null },
        profile: { authMode: "subscription" },
        attachments: [],
      } as any,
      cwd: process.cwd(),
      prompt: "Hello",
      files: [],
      signal: new AbortController().signal,
      emit: (type, data) => events.push({ type, data }),
      flush: async () => {},
      approve: async (...args) => {
        requests.push(args);
        return { optionId: agent === "codex" ? "accept" : "allow" };
      },
    };
    await run(rt);
    assert.ok(events.some((e) => e.type === "native"));
    assert.ok(events.some((e) => e.type === "item" && e.data.text === "Hello"));
    assert.equal(requests.length, 1);
    const latest = new Map(
      events.filter((e) => e.type === "item").map((e) => [e.data.id, e.data]),
    );
    assert.equal(
      [...latest.values()].filter((x) => x.kind === "assistant").length,
      1,
    );
    const ctx = latest.get("job1:context")?.input;
    if (agent === "claude") {
      // prompt size of the root call + the main model's window
      // (older clients read these two).
      assert.equal(ctx.used, 50000);
      assert.equal(ctx.window, 200000);
      // Claude's own trigger point (window 200K − 33K) and this
      // job's cache counters (input + cache read + cache write).
      assert.equal(ctx.v, 1);
      assert.deepEqual(
        {
          tokens: ctx.threshold.tokens,
          source: ctx.threshold.source,
          origin: ctx.threshold.origin,
          window: ctx.threshold.window,
          applied: ctx.threshold.applied,
        },
        {
          tokens: 167000,
          source: "harness",
          origin: "cli-default",
          window: 200000,
          applied: null,
        },
      );
      assert.deepEqual(ctx.cache, { prompt: 50000, read: 40000, write: 9990 });
    }
    delete process.env[`DAISY_${agent.toUpperCase()}_BIN`];
  });
test("workspace canonicalization rejects escaping symlinks; subscription scrubs API env", () => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "daisy-path-")));
  mkdirSync(join(dir, "allowed"));
  mkdirSync(join(dir, "outside"));
  symlinkSync(join(dir, "outside"), join(dir, "allowed", "escape"));
  assert.throws(() =>
    safeWorkspace(join(dir, "allowed", "escape"), [join(dir, "allowed")]),
  );
  assert.equal(
    safeWorkspace(join(dir, "allowed"), [join(dir, "allowed")]),
    join(dir, "allowed"),
  );
  const old = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "inherited-secret";
  assert.equal(
    agentEnv({
      profile: { authMode: "subscription" },
      session: { agent: "claude" },
    } as any).ANTHROPIC_API_KEY,
    undefined,
  );
  if (old) process.env.ANTHROPIC_API_KEY = old;
  else delete process.env.ANTHROPIC_API_KEY;
  rmSync(dir, { recursive: true, force: true });
});

test("subscription profiles reject API-key identities before starting a model turn", async () => {
  process.env.DAISY_FIXTURE_AUTH = "apiKey";
  try {
    for (const [agent, run] of Object.entries({
      claude: runClaude,
      codex: runCodex,
    })) {
      process.env[`DAISY_${agent.toUpperCase()}_BIN`] = resolve(
        "tests/fixtures/agent.cjs",
      );
      const rt: Runtime = {
        job: {
          id: "billing-check",
          session: { agent, nativeId: null },
          profile: { authMode: "subscription" },
        } as any,
        cwd: process.cwd(),
        prompt: "Never sent",
        files: [],
        signal: new AbortController().signal,
        emit: () => {},
        flush: async () => {},
        approve: async () => ({ optionId: "deny" }),
      };
      await assert.rejects(() => run(rt), /不会回退到 API key/);
      delete process.env[`DAISY_${agent.toUpperCase()}_BIN`];
    }
  } finally {
    delete process.env.DAISY_FIXTURE_AUTH;
    delete process.env.DAISY_CLAUDE_BIN;
    delete process.env.DAISY_CODEX_BIN;
  }
});

test("Codex child completion does not end parent; native policy options and MCP forms reach UI", async () => {
  process.env.DAISY_CODEX_BIN = resolve("tests/fixtures/agent.cjs");
  const events: any[] = [],
    requests: any[] = [];
  try {
    await runCodex({
      job: {
        id: "deep",
        session: { agent: "codex", nativeId: null },
        profile: { authMode: "subscription" },
      } as any,
      cwd: process.cwd(),
      prompt: "DEEP_PROTOCOL_TEST",
      files: [],
      signal: new AbortController().signal,
      emit: (type, data) => events.push({ type, data }),
      flush: async () => {},
      approve: async (title, input, options) => {
        requests.push({ title, input, options });
        return title.startsWith("MCP")
          ? { optionId: "accept", answers: { json: '{"name":"reviewer"}' } }
          : { optionId: "native-1" };
      },
    });
    assert.ok(
      events.some(
        (e) =>
          e.data.category === "subagent" &&
          e.data.text === "Child visible output",
      ),
    );
    assert.ok(
      events.some((e) =>
        e.data.text?.startsWith("Parent continued after child and MCP"),
      ),
    );
    // C1-a/C1-b: Codex 0.165 offers no decline; Daisy adds 拒绝 before
    // 取消本轮 and names the rule amendment instead of dumping its JSON.
    assert.deepEqual(requests[0].options, [
      { id: "accept", label: "允许本次" },
      { id: "native-1", label: "允许，以后不再问：pwd" },
      { id: "decline", label: "拒绝" },
      { id: "cancel", label: "取消本轮" },
    ]);
    assert.ok(
      events.some(
        (e) =>
          e.data.text ===
          'Approval decision: {"acceptWithExecpolicyAmendment":{"execpolicy_amendment":["pwd"]}}',
      ),
    );
    assert.equal(requests[1].title, "MCP 服务需要你的确认");
  } finally {
    delete process.env.DAISY_CODEX_BIN;
  }
});

test("Codex command approvals offer decline even when availableDecisions omits it, and answer it natively (C1-a)", async () => {
  process.env.DAISY_CODEX_BIN = resolve("tests/fixtures/agent.cjs");
  const events: any[] = [],
    requests: any[] = [];
  try {
    await runCodex({
      job: {
        id: "deep-decline",
        session: { agent: "codex", nativeId: null },
        profile: { authMode: "subscription" },
      } as any,
      cwd: process.cwd(),
      prompt: "DEEP_PROTOCOL_TEST",
      files: [],
      signal: new AbortController().signal,
      emit: (type, data) => events.push({ type, data }),
      flush: async () => {},
      approve: async (title, input, options) => {
        requests.push({ title, input, options });
        return title.startsWith("MCP")
          ? { optionId: "accept", answers: { json: '{"name":"reviewer"}' } }
          : { optionId: "decline" };
      },
    });
    assert.ok(
      events.some((e) => e.data.text === 'Approval decision: "decline"'),
    );
  } finally {
    delete process.env.DAISY_CODEX_BIN;
  }
});

test("Codex approval options: decline added once, before cancel; labels are human (C1-a/C1-b)", () => {
  const ids = (a: unknown) => codexApprovalOptions(a).options.map((o) => o.id);
  // Codex 0.165.0 live shape.
  assert.deepEqual(
    ids([
      "accept",
      {
        acceptWithExecpolicyAmendment: {
          execpolicy_amendment: ["cat", "c1-approve.txt"],
        },
      },
      "cancel",
    ]),
    ["accept", "native-1", "decline", "cancel"],
  );
  // Already offered: kept where Codex put it, not duplicated.
  assert.deepEqual(ids(["decline", "accept", "cancel"]), [
    "decline",
    "accept",
    "cancel",
  ]);
  // No cancel: appended at the end.
  assert.deepEqual(ids(["accept", "acceptForSession"]), [
    "accept",
    "acceptForSession",
    "decline",
  ]);
  // Missing / empty list (file changes from older servers): the full set.
  for (const a of [undefined, null, []])
    assert.deepEqual(ids(a), [
      "accept",
      "acceptForSession",
      "decline",
      "cancel",
    ]);
  // The wire decision for each option is Codex's own value, verbatim.
  const amend = {
    acceptWithExecpolicyAmendment: { execpolicy_amendment: ["cat", "x"] },
  };
  const { decisions, options } = codexApprovalOptions([
    "accept",
    amend,
    "cancel",
  ]);
  assert.equal(decisions[options.findIndex((o) => o.id === "native-1")], amend);
  assert.equal(
    decisions[options.findIndex((o) => o.id === "decline")],
    "decline",
  );

  assert.equal(
    codexDecisionLabel({
      acceptWithExecpolicyAmendment: {
        execpolicy_amendment: ["cat", "c1-approve.txt"],
      },
    }),
    "允许，以后不再问：cat c1-approve.txt",
  );
  const long = codexDecisionLabel({
    acceptWithExecpolicyAmendment: {
      execpolicy_amendment: ["echo", "x".repeat(200)],
    },
  });
  assert.ok(long.startsWith("允许，以后不再问：echo xxx"));
  assert.equal(long.length, "允许，以后不再问：".length + 80);
  assert.ok(long.endsWith("…"));
  assert.equal(
    codexDecisionLabel({
      applyNetworkPolicyAmendment: {
        network_policy_amendment: { action: "allow", host: "api.example.com" },
      },
    }),
    "允许，并放行网络：api.example.com",
  );
  assert.equal(
    codexDecisionLabel({
      applyNetworkPolicyAmendment: {
        network_policy_amendment: { action: "deny", host: "evil.example" },
      },
    }),
    "拒绝，并封禁网络：evil.example",
  );
  const unknown = codexDecisionLabel({ somethingNew: { a: [1, 2, 3] } });
  assert.equal(unknown, "允许（somethingNew）");
  assert.ok(!unknown.includes("{"));
  assert.equal(codexDecisionLabel("acceptForSession"), "允许此会话");
});

test("Claude interleaved child streams stay separate and background tasks finish before process shutdown", async () => {
  process.env.DAISY_CLAUDE_BIN = resolve("tests/fixtures/agent.cjs");
  const events: any[] = [];
  try {
    await runClaude({
      job: {
        id: "claude-deep",
        session: { agent: "claude", nativeId: null },
        profile: { authMode: "subscription" },
      } as any,
      cwd: process.cwd(),
      prompt: "DEEP_PROTOCOL_TEST",
      files: [],
      signal: new AbortController().signal,
      emit: (type, data) => events.push({ type, data }),
      flush: async () => {},
      approve: async () => ({ optionId: "allow" }),
    });
    const latest = new Map(
      events.filter((e) => e.type === "item").map((e) => [e.data.id, e.data]),
    );
    assert.equal(
      [...latest.values()].filter((x) => x.kind === "assistant").length,
      1,
    );
    assert.ok(
      [...latest.values()].some(
        (x) => x.kind === "assistant" && x.text === "Hello",
      ),
    );
    assert.ok(
      [...latest.values()].some(
        (x) => x.category === "subagent" && x.text === "Child Hello",
      ),
    );
    assert.ok(
      [...latest.values()].some(
        (x) =>
          x.text === "Background finished after parent result" &&
          x.status === "complete",
      ),
    );
  } finally {
    delete process.env.DAISY_CLAUDE_BIN;
  }
});

for (const timing of ["1", "early"])
  test(`Claude keeps the process alive for the follow-up turn a background report starts (report ${timing === "early" ? "before" : "after"} the result)`, async () => {
    process.env.DAISY_CLAUDE_BIN = resolve("tests/fixtures/agent.cjs");
    process.env.DAISY_FIXTURE_FOLLOWUP = timing;
    const events: any[] = [];
    try {
      await runClaude({
        job: {
          id: "claude-follow",
          session: { agent: "claude", nativeId: null },
          profile: { authMode: "subscription" },
        } as any,
        cwd: process.cwd(),
        prompt: "DEEP_PROTOCOL_TEST",
        files: [],
        signal: new AbortController().signal,
        emit: (type, data) => events.push({ type, data }),
        flush: async () => {},
        approve: async () => ({ optionId: "allow" }),
      });
      const latest = new Map(
        events.filter((e) => e.type === "item").map((e) => [e.data.id, e.data]),
      );
      assert.ok(
        [...latest.values()].some(
          (x) =>
            x.kind === "assistant" && x.text === "Read the background report",
        ),
        "the follow-up reply must be captured, not cut off by process shutdown",
      );
    } finally {
      delete process.env.DAISY_CLAUDE_BIN;
      delete process.env.DAISY_FIXTURE_FOLLOWUP;
    }
  });

test("Codex subscription refuses a non-OpenAI provider before sending a turn", async () => {
  process.env.DAISY_CODEX_BIN = resolve("tests/fixtures/agent.cjs");
  process.env.DAISY_FIXTURE_PROVIDER = "external";
  try {
    await assert.rejects(
      () =>
        runCodex({
          job: {
            id: "provider-check",
            session: { agent: "codex", nativeId: null },
            profile: { authMode: "subscription" },
          } as any,
          cwd: process.cwd(),
          prompt: "Never sent",
          files: [],
          signal: new AbortController().signal,
          emit: () => {},
          flush: async () => {},
          approve: async () => ({ optionId: "decline" }),
        }),
      /拒绝使用其他模型供应商/,
    );
  } finally {
    delete process.env.DAISY_CODEX_BIN;
    delete process.env.DAISY_FIXTURE_PROVIDER;
  }
});

test(
  "Claude live input waits for official replay acknowledgement and both results",
  { timeout: 10000 },
  async () => {
    process.env.DAISY_CLAUDE_BIN = resolve("tests/fixtures/agent.cjs");
    let input: ((text: string) => Promise<void>) | null = null,
      delivered = false;
    const rt: any = {
      job: {
        id: "claude-live",
        text: "first",
        session: { agent: "claude", nativeId: null },
        profile: { authMode: "subscription" },
      },
      cwd: process.cwd(),
      prompt: "first",
      files: [],
      signal: AbortSignal.timeout(8000),
      emit: () => {},
      flush: async () => {},
      onInput: (handler: any) => {
        input = handler;
      },
      approve: async () => {
        assert.ok(input);
        await input!("additional");
        delivered = true;
        return { optionId: "allow" };
      },
    };
    try {
      await runClaude(rt);
      assert.equal(delivered, true);
      assert.equal(input, null);
    } finally {
      delete process.env.DAISY_CLAUDE_BIN;
    }
  },
);

test("Claude per-block assistant events map onto stream indices (no duplicate reply, thinking kept)", async () => {
  process.env.DAISY_CLAUDE_BIN = resolve("tests/fixtures/agent.cjs");
  const events: any[] = [];
  try {
    await runClaude({
      job: {
        id: "claude-split",
        session: { agent: "claude", nativeId: null },
        profile: { authMode: "subscription" },
      } as any,
      cwd: process.cwd(),
      prompt: "SPLIT_BLOCKS_TEST",
      files: [],
      signal: new AbortController().signal,
      emit: (type, data) => events.push({ type, data }),
      flush: async () => {},
      approve: async () => ({ optionId: "allow" }),
    });
    const latest = new Map(
      events.filter((e) => e.type === "item").map((e) => [e.data.id, e.data]),
    );
    const all = [...latest.values()];
    const assistant = all.filter((x) => x.kind === "assistant");
    assert.deepEqual(
      assistant.map((x) => x.text),
      ["Part one and two", "Second answer"],
    );
    assert.deepEqual(
      all.filter((x) => x.kind === "thinking").map((x) => x.text),
      ["Pondering", "Second thought"],
    );
    // The partially streamed text and its final event share one item.
    assert.equal(
      events.filter(
        (e) => e.type === "item" && /^Part one/.test(e.data.text || ""),
      ).length >= 2,
      true,
    );
    assert.equal(
      new Set(
        events
          .filter(
            (e) => e.type === "item" && /^Part one/.test(e.data.text || ""),
          )
          .map((e) => e.data.id),
      ).size,
      1,
    );
    assert.equal(
      all.filter((x) => x.kind === "tool" && x.name === "Bash").length,
      1,
    );
  } finally {
    delete process.env.DAISY_CLAUDE_BIN;
  }
});
