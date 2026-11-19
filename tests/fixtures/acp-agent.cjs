#!/usr/bin/env node
/**
 * P4-10: a fake ACP v1 agent (stdio JSON-RPC), one profile per entry of the
 * ACP harness table (contracts acp-harnesses.ts), as P0-03 found each one
 * (docs/research/acp-harnesses.md, deepseek-harness.md). The Kimi fake in
 * agent.cjs (`acp` mode) stays for the older tests; this one declares what
 * each harness declares and answers only what it supports.
 *
 *   FAKE_ACP_PROFILE  kimi | opencode | antigravity | deepseek | minimal
 *   FAKE_ACP_STATE    directory: each native session's markers, kept across
 *                     processes (so a resumed session remembers)
 *   FAKE_ACP_RECORD   JSONL file: every request Daisy sent ({profile, method, params})
 *
 * A prompt: thought, a tool call that asks permission (`session/
 * request_permission`, allow / reject), the tool's result, the answer
 * `markers: a,b` (every `[[word]]` this session has seen, in order), a
 * usage update, then `end_turn`. `SLOW` in the prompt: the turn waits for
 * `session/cancel` and ends `cancelled`. `NOTOOL`: no permission request.
 */
const fs = require("node:fs");
const path = require("node:path");
const profileName = process.env.FAKE_ACP_PROFILE || "minimal";
if (process.argv.includes("--version")) {
  process.stdout.write(`${profileName} 1.2.3 (fake acp)\n`);
  process.exit(0);
}
const opt = (id, category, values, current) => ({
  id,
  name: id,
  category,
  type: "select",
  currentValue: current,
  options: values.map((value) => ({ value, name: value })),
});
const PROFILES = {
  kimi: {
    loadSession: true,
    session: { list: {}, resume: {}, close: {}, delete: {}, fork: {} },
    options: [
      opt("model", "model", ["kimi-k3", "kimi-k3-turbo"], "kimi-k3"),
      opt("thinking", "thought_level", ["low", "high", "max"], "high"),
      opt("mode", "mode", ["default", "plan", "auto", "yolo"], "default"),
    ],
    modes: ["default", "plan", "auto", "yolo"],
    setModel: true,
    commands: ["compact", "undo"],
  },
  opencode: {
    loadSession: true,
    session: { list: {}, resume: {}, close: {}, delete: {}, fork: {}, additionalDirectories: {} },
    options: [
      opt("model", "model", ["anthropic/claude", "openai/gpt"], "anthropic/claude"),
      opt("effort", "thought_level", ["low", "medium", "high"], "medium"),
      opt("mode", "mode", ["build", "plan"], "build"),
    ],
    modes: ["build", "plan"],
    commands: ["init", "review"],
  },
  antigravity: {
    loadSession: true,
    session: { list: {}, resume: {}, close: {} },
    options: [
      opt("model", "model", ["gemini-pro", "gemini-flash"], "gemini-pro"),
      opt("thinking_level", "thought_level", ["low", "medium", "high", "max"], "medium"),
    ],
    modes: null,
  },
  deepseek: {
    loadSession: false,
    session: { list: {}, resume: {}, close: {} },
    options: [
      opt("model", "model", ["deepseek-v4", "deepseek-v4-flash"], "deepseek-v4"),
      opt("reasoning_effort", "thought_level", ["low", "medium", "high"], "medium"),
    ],
    modes: null,
  },
  // C-5: an ACP agent Daisy has no entry for — only load, nothing optional.
  minimal: { loadSession: true, session: {}, options: [], modes: null },
};
const P = PROFILES[profileName];
if (!P) {
  process.stderr.write(`unknown FAKE_ACP_PROFILE ${profileName}\n`);
  process.exit(2);
}
const stateDir = process.env.FAKE_ACP_STATE || "";
const record = (method, params) => {
  if (process.env.FAKE_ACP_RECORD)
    fs.appendFileSync(
      process.env.FAKE_ACP_RECORD,
      JSON.stringify({ profile: profileName, pid: process.pid, method, params }) + "\n",
    );
};
const stateFile = (sid) => stateDir && path.join(stateDir, `${sid.replace(/[^\w-]/g, "_")}.json`);
const load = (sid) => {
  const f = stateFile(sid);
  return f && fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null;
};
const save = (sid, st) => {
  const f = stateFile(sid);
  if (f) fs.writeFileSync(f, JSON.stringify(st));
};
const sessions = new Map();
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
const result = (id, r) => send({ id, result: r });
const error = (id, code, message) => send({ id, error: { code, message } });
const update = (sessionId, u) => send({ method: "session/update", params: { sessionId, update: u } });
/** Advertised before the answer here (real agents send it right after). */
const advertise = (sid) =>
  P.commands &&
  update(sid, {
    sessionUpdate: "available_commands_update",
    availableCommands: P.commands.map((name) => ({ name, description: name })),
  });
const sessionAnswer = (sid) => ({
  sessionId: sid,
  configOptions: P.options,
  ...(P.modes
    ? {
        modes: {
          currentModeId: P.modes[0],
          availableModes: P.modes.map((id) => ({ id, name: id })),
        },
      }
    : {}),
});
let seq = 0;
/** The running prompt of each session: its request id and how to end it. */
const running = new Map();
const permissions = new Map();
const finish = (sid, reason) => {
  const r = running.get(sid);
  if (!r) return;
  running.delete(sid);
  result(r.id, { stopReason: reason });
};
function prompt(m) {
  const sid = m.params.sessionId;
  const st = sessions.get(sid);
  if (!st) return error(m.id, -32602, `Unknown session ${sid}`);
  if (running.has(sid)) return error(m.id, -32600, "A prompt is already running");
  const text = (m.params.prompt || []).map((b) => b.text || "").join("\n");
  for (const x of text.matchAll(/\[\[(\w+)\]\]/g)) st.markers.push(x[1]);
  st.turns.push(text.slice(0, 200));
  save(sid, st);
  running.set(sid, { id: m.id });
  update(sid, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Thinking about it" } });
  if (/SLOW/.test(text)) {
    update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Working slowly" } });
    return; // until session/cancel
  }
  const answer = () => {
    update(sid, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: `markers: ${st.markers.join(",") || "none"}` },
    });
    update(sid, { sessionUpdate: "usage_update", used: 1200 * st.turns.length, size: 200000 });
    finish(sid, "end_turn");
  };
  // P4-05: `FX_WRITE <rel> <text>` writes a file unless the session is in
  // its read-only mode (plan) — a weak read-only the agent itself honours;
  // `FX_SAY <text>` (\n for new lines) is the answer.
  if (/^FX_(WRITE|SAY) /m.test(text)) {
    const out = [];
    for (const [, rel, body] of text.matchAll(/^FX_WRITE (\S+) (.*)$/gm)) {
      if (st.mode === "plan") {
        out.push(`refused ${rel} (plan)`);
        continue;
      }
      const abs = path.resolve(process.cwd(), rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, body + "\n");
      out.push(`wrote ${rel}`);
    }
    const say = [...text.matchAll(/^FX_SAY (.*)$/gm)].at(-1);
    update(sid, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: say ? say[1].replace(/\\n/g, "\n") : out.join("; ") || "ok" },
    });
    return finish(sid, "end_turn");
  }
  if (/NOTOOL/.test(text)) return answer();
  const call = `call-${++seq}`;
  update(sid, { sessionUpdate: "tool_call", toolCallId: call, title: "Read notes.md", kind: "read", status: "pending", rawInput: { path: "notes.md" } });
  const rid = `perm-${seq}`;
  permissions.set(rid, (outcome) => {
    const allowed = outcome?.outcome === "selected" && outcome.optionId === "allow";
    update(sid, {
      sessionUpdate: "tool_call_update",
      toolCallId: call,
      status: allowed ? "completed" : "failed",
      content: [{ type: "content", content: { type: "text", text: allowed ? "notes read" : "denied by the user" } }],
    });
    if (!running.has(sid)) return;
    if (!allowed)
      update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "tool denied; " } });
    answer();
  });
  send({
    id: rid,
    method: "session/request_permission",
    params: {
      sessionId: sid,
      toolCall: { toolCallId: call, title: "Read notes.md", kind: "read" },
      options: [
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "reject", name: "Reject", kind: "reject_once" },
      ],
    },
  });
}
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    if (!line) continue;
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    handle(m);
  }
});
process.stdin.on("end", () => process.exit(0));
function handle(m) {
  // A client answer (to request_permission).
  if (!m.method && m.id !== undefined) {
    const done = permissions.get(m.id);
    permissions.delete(m.id);
    done?.(m.result?.outcome);
    return;
  }
  record(m.method, m.params);
  const p = m.params || {};
  switch (m.method) {
    case "initialize":
      return result(m.id, {
        protocolVersion: 1,
        agentInfo: { name: `fake-${profileName}`, version: "1.2.3" },
        agentCapabilities: {
          ...(P.loadSession ? { loadSession: true } : {}),
          promptCapabilities: { image: true, embeddedContext: true },
          sessionCapabilities: P.session,
        },
        authMethods: [],
      });
    case "session/new": {
      const sid = `${profileName}-sess-${process.pid}-${++seq}`;
      sessions.set(sid, { markers: [], turns: [] });
      save(sid, sessions.get(sid));
      advertise(sid);
      return result(m.id, sessionAnswer(sid));
    }
    case "session/load":
    case "session/resume": {
      const declared = m.method === "session/load" ? P.loadSession : !!P.session.resume;
      if (!declared) return error(m.id, -32601, `Method not found: ${m.method}`);
      const st = load(p.sessionId);
      if (!st) return error(m.id, -32002, `Resource not found: ${p.sessionId}`);
      // A new process starts in the agent's default mode.
      delete st.mode;
      sessions.set(p.sessionId, st);
      // session/load replays the history; session/resume does not.
      if (m.method === "session/load")
        for (const t of st.turns)
          update(p.sessionId, { sessionUpdate: "user_message_chunk", content: { type: "text", text: t } });
      advertise(p.sessionId);
      return result(m.id, sessionAnswer(p.sessionId));
    }
    case "session/fork": {
      if (!P.session.fork) return error(m.id, -32601, "Method not found: session/fork");
      const st = load(p.sessionId) || sessions.get(p.sessionId);
      if (!st) return error(m.id, -32002, `Resource not found: ${p.sessionId}`);
      const sid = `fork-${p.sessionId}`;
      sessions.set(sid, JSON.parse(JSON.stringify(st)));
      save(sid, sessions.get(sid));
      return result(m.id, sessionAnswer(sid));
    }
    case "session/set_config_option": {
      const o = P.options.find((x) => x.id === p.configId);
      if (!o) return error(m.id, -32602, `Unknown config option ${p.configId}`);
      o.currentValue = p.value;
      if (p.configId === "mode" && sessions.get(p.sessionId)) sessions.get(p.sessionId).mode = p.value;
      return result(m.id, { configOptions: P.options });
    }
    case "session/set_mode":
      if (!P.modes) return error(m.id, -32601, "Method not found: session/set_mode");
      if (!P.modes.includes(p.modeId)) return error(m.id, -32602, `Unknown mode ${p.modeId}`);
      if (sessions.get(p.sessionId)) sessions.get(p.sessionId).mode = p.modeId;
      return result(m.id, {});
    case "session/set_model":
      // Removed from ACP; Kimi Code keeps it as an extension.
      if (!P.setModel) return error(m.id, -32601, "Method not found: session/set_model");
      return result(m.id, {});
    case "session/prompt":
      return prompt(m);
    case "session/cancel":
      // DAISY_FIXTURE_EXIT_ON_INTERRUPT: the process ends at once, before
      // the turn's `cancelled` — its exit reaches Daisy first (P5 gate).
      if (process.env.DAISY_FIXTURE_EXIT_ON_INTERRUPT) process.exit(0);
      finish(p.sessionId, "cancelled");
      for (const [rid, done] of permissions) {
        permissions.delete(rid);
        done({ outcome: "cancelled" });
      }
      return;
    default:
      if (m.id !== undefined) error(m.id, -32601, `Method not found: ${m.method}`);
  }
}
