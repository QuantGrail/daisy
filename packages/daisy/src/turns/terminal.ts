import { turnT } from "../harness/model-switch.ts";
import { fileURLToPath } from "node:url";
import {
  acpHarness,
  agentCommand,
} from "../../../contracts/src/acp-harnesses.ts";
import { trackGroup, untrackGroup } from "../platform/process-groups.ts";
import { execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import { resolveSpawn, spawnTree } from "../platform/spawn.ts";
import { promisify } from "node:util";
import { stripVTControlCharacters } from "node:util";
import { createInterface } from "node:readline";
import { agentEnv, stage, type Runtime } from "../harness/shared.ts";
import {
  authLogLine,
  checkClaudeAuth,
  claudeAuthMessage,
  probeOf,
} from "../harness/claude-auth.ts";
import { log } from "../observe/log.ts";
export async function runTerminal(
  rt: Runtime,
  exchange: (part: number, data: string) => Promise<{ inputs: any[] }>,
) {
  const agent = rt.job.session.agent,
    sid = rt.job.session.nativeId;
  if (!sid || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,299}$/.test(sid))
    throw Error(turnT()("server-turns.terminal.needSession"));
  // P4-10: an ACP harness opens its CLI as its entry says (acp-harnesses.ts).
  const acp = acpHarness(agent);
  if (acp && !acp.terminal)
    throw Error(turnT()("server-turns.terminal.acpUnsupported", { short: acp.short }));
  const bin = agentCommand(agent),
    env = {
      ...agentEnv(rt.job),
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
    };
  if (agent === "codex" && rt.job.profile.authMode === "subscription") {
    const [file, pre] = resolveSpawn(bin, ["login", "status"], env);
    const r = await promisify(execFile)(file, pre, {
      env,
      cwd: rt.cwd,
      timeout: 10000,
    });
    if (!/ChatGPT/i.test(r.stdout + r.stderr))
      throw Error(turnT()("server-turns.terminal.needChatgpt"));
  }
  if (agent === "claude" && rt.job.profile.authMode === "subscription") {
    // N-9 / ADR-133: the same check and wording as a turn's preflight.
    const verdict = await checkClaudeAuth(
      (timeout) =>
        promisify(execFile)(...resolveSpawn(bin, ["auth", "status", "--json"], env), {
          env,
          cwd: rt.cwd,
          timeout,
        }).then(
          (r) => probeOf(null, r),
          (e) => probeOf(e),
        ),
      {
        configDir: rt.job.profile.configDir,
        onFailure: (p, v, attempt) =>
          log.warn(
            authLogLine(`terminal, identity ${rt.job.profile.id}, attempt ${attempt}`, p, v),
          ),
      },
    );
    if (verdict.kind !== "ok") throw Error(claudeAuthMessage(verdict));
  }
  const profile = rt.job.profile;
  const args =
    agent === "codex"
      ? [
          "-c",
          'model_provider="openai"',
          "-c",
          'approvals_reviewer="user"',
          ...(profile.model ? ["--model", profile.model] : []),
          ...(profile.reasoningEffort
            ? [
                "-c",
                `model_reasoning_effort=${JSON.stringify(profile.reasoningEffort)}`,
              ]
            : []),
          // the server only accepts a lowercase word here.
          ...(profile.serviceTier &&
          /^[a-z][a-z0-9_-]*$/.test(profile.serviceTier)
            ? ["-c", `service_tier=${JSON.stringify(profile.serviceTier)}`]
            : []),
          "--ask-for-approval",
          profile.permissionMode || "on-request",
          "--sandbox",
          profile.sandboxMode || "workspace-write",
          "resume",
          sid,
          "--no-alt-screen",
        ]
      : agent === "claude"
        ? [
            "--resume",
            sid,
            "--permission-mode",
            profile.permissionMode || "manual",
            ...(profile.model ? ["--model", profile.model] : []),
            ...(profile.reasoningEffort
              ? ["--effort", profile.reasoningEffort]
              : []),
          ]
        : [
            ...acp!.terminal!.args.map((a) => a.replace("{sid}", sid)),
            ...(profile.model && acp!.terminal!.model
              ? acp!.terminal!.model.map((a) => a.replace("{model}", profile.model))
              : []),
            ...((profile.permissionMode &&
              acp!.terminal!.modes?.[profile.permissionMode]) ||
              []),
          ];
  // The pseudo terminal: Python's pty (Linux / macOS, its own group) or
  // Windows' own ConPTY through the helper, in a Job Object (P5-05,
  // ADR-141) — the same JSON-line protocol either way.
  const child = (
    process.platform === "win32"
      ? spawnTree(bin, args, { cwd: rt.cwd, env, stdio: ["pipe", "pipe", "pipe"], pty: { cols: 100, rows: 30 } })
      : spawnTree(
          "python3",
          [fileURLToPath(new URL("./terminal-pty.py", import.meta.url)), bin, ...args],
          { cwd: rt.cwd, env, stdio: ["pipe", "pipe", "pipe"] },
        )
  ) as ChildProcessWithoutNullStreams;
  // P1-02 / C-4: recorded, so a next start can end it if this process is killed.
  trackGroup(child.pid);
  child.once("exit", () => untrackGroup(child.pid));
  const output: string[] = [];
  let queuedBytes = 0,
    part = 0,
    closed = false,
    lastError = "",
    transcript = "";
  const stop = () => {
    try {
      child.kill("SIGTERM");
    } catch {}
  };
  rt.signal.addEventListener("abort", stop, { once: true });
  if (rt.signal.aborted) stop();
  const ended = new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => {
      closed = true;
      resolve(code);
    });
  });
  ended.catch(() => {});
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    try {
      const m = JSON.parse(line);
      if (m.data) {
        transcript = (
          transcript + Buffer.from(m.data, "base64").toString("utf8")
        ).slice(-40000);
        output.push(m.data);
        queuedBytes += m.data.length;
        if (queuedBytes > 16 * 1024 * 1024) {
          lastError = turnT()("server-turns.terminal.backlog");
          stop();
        }
      }
    } catch {
      lastError = turnT()("server-turns.terminal.bridgeError");
      stop();
    }
  });
  child.stderr.on("data", (s) => {
    lastError = (lastError + s).slice(-2000);
  });
  child.stdin.on("error", () => {});
  stage(rt, "terminal", turnT()("server-turns.terminal.started"), "running");
  await rt.flush();
  try {
    while ((!closed || output.length) && !rt.signal.aborted) {
      const data = output[0] || "";
      try {
        const r = await exchange(part, data);
        if (data) {
          output.shift();
          queuedBytes -= data.length;
          part++;
        }
        for (const input of r.inputs)
          if (!closed) child.stdin.write(JSON.stringify(input) + "\n");
      } catch (e: any) {
        if (e.status && e.status < 500) throw e;
        await new Promise((r) => setTimeout(r, 500));
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    if (rt.signal.aborted) stop();
    const code = await ended;
    if (code !== 0 && !rt.signal.aborted)
      throw Error(lastError || turnT()("server-turns.terminal.exited", { code: String(code) }));
    stage(rt, "terminal", turnT()("server-turns.terminal.ended"), "complete");
    return { completed: true };
  } finally {
    rt.emit("item", {
      id: `${rt.job.id}:terminal-record`,
      kind: "tool",
      category: "native",
      name: turnT()("server-turns.terminal.record"),
      text: stripVTControlCharacters(transcript).slice(-30000),
      status: rt.signal.aborted ? "cancelled" : "complete",
      createdAt: Date.now(),
    });
    rt.signal.removeEventListener("abort", stop);
    stop();
    lines.close();
  }
}
