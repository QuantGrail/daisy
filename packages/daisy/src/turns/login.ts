import { turnT } from "../harness/model-switch.ts";
import { daisyEnv } from "../../../contracts/src/env.ts";
import { spawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import { resolveSpawn, spawnTree } from "../platform/spawn.ts";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { JsonProcess } from "./transport.ts";
import { agentEnv } from "../harness/shared.ts";
import {
  acpHarness,
  harnessText,
  agentCommand,
} from "../../../contracts/src/acp-harnesses.ts";
import { resolveIdentity } from "./identity.ts";
import { nodeApi, type NodeConfig } from "./worker.ts";
import { restartLoginError, restartAborted } from "../update/restart.ts";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export async function executeLogin(
  config: NodeConfig,
  job: any,
  signal: AbortSignal,
) {
  const profile = resolveIdentity(
    job.profile,
    config.nodeId,
    config.identityRoot,
  );
  const env = agentEnv({ profile, session: { agent: profile.agent } } as any);
  const cwd = profile.configDir;
  let stop = () => {},
    input = (code: string) => {},
    ended = false,
    lastPulse = Date.now(),
    pulsing = false;
  const controller = new AbortController();
  const abort = () => {
    controller.abort();
    stop();
  };
  signal.addEventListener("abort", abort, { once: true });
  const post = (suffix: string, body: any = {}) =>
    nodeApi(config, `/logins/${job.id}/${suffix}`, body, job.lease);
  const timer = setInterval(async () => {
    if (pulsing || ended) return;
    pulsing = true;
    try {
      const r = await post("pulse");
      lastPulse = Date.now();
      if (r.cancel) abort();
      else if (r.code) input(r.code);
    } catch (e: any) {
      if (e.status === 409 || Date.now() - lastPulse > 25000) abort();
    } finally {
      pulsing = false;
    }
  }, 1000);
  const expiry = setTimeout(
    abort,
    Math.max(1, Math.min(15 * 60_000, job.expiresAt - Date.now())),
  );
  try {
    if (signal.aborted) throw Error(turnT()("server-turns.login.cancelled"));
    if (profile.agent === "codex") {
      const p = new JsonProcess(
        daisyEnv("DAISY_CODEX_BIN") || "codex",
        ["app-server"],
        { cwd, env },
      );
      stop = () => p.stop();
      let finish!: (x: any) => void, reject!: (e: Error) => void;
      const completion = new Promise<any>((a, b) => {
        finish = a;
        reject = b;
      });
      completion.catch(() => {});
      p.onExit = reject;
      p.onMessage = (m) => {
        if (m.method === "account/login/completed") finish(m.params);
      };
      await p.request("initialize", {
        clientInfo: { name: "daisy", version: "0.2.0" },
        capabilities: { experimentalApi: true },
      });
      p.send({ method: "initialized", params: {} });
      const r = await p.request("account/login/start", {
        type: "chatgptDeviceCode",
      });
      await post("update", {
        status: "waiting",
        url: r.verificationUrl,
        userCode: r.userCode,
        message: turnT()("server-turns.login.deviceCode"),
      });
      const outcome = await completion;
      if (!outcome.success) throw Error(outcome.error || turnT()("server-turns.login.notAuthorized"));
      const account = await p.request("account/read", { refreshToken: false });
      if (account.account?.type !== "chatgpt")
        throw Error(turnT()("server-turns.login.noChatgpt"));
    } else {
      // P4-10: an ACP harness logs in by its entry's own command (absent:
      // the server refused already — loginStart).
      const acp = acpHarness(profile.agent);
      if (acp && !acp.login)
        throw Error(turnT()("server-turns.login.acpUnsupported", { name: acp.name, hint: harnessText(acp, "loginHint", turnT()) }));
      const command = agentCommand(profile.agent);
      const args =
        profile.agent === "claude"
          ? ["auth", "login", "--claudeai"]
          : acp
            ? [...acp.login!.args]
            : ["login"];
      const hosts = new Set(acp?.login?.hosts ?? []);
      // A pseudo terminal: Python's pty (Linux / macOS), Windows' ConPTY
      // through the helper (P5-05: JSON lines in and out, like the terminal
      // window; wide, so a long link is not wrapped).
      const win = process.platform === "win32";
      const child = (
        win
          ? spawnTree(command, args, {
              cwd,
              env: { ...env, TERM: "dumb", NO_COLOR: "1" },
              stdio: ["pipe", "pipe", "pipe"],
              pty: { cols: 4000, rows: 40 },
            })
          : spawn(
              "python3",
              [fileURLToPath(new URL("./login-pty.py", import.meta.url)), command, ...args],
              {
                cwd,
                env: { ...env, BROWSER: "/bin/true", TERM: "dumb", NO_COLOR: "1" },
                stdio: ["pipe", "pipe", "pipe"],
              },
            )
      ) as ChildProcessWithoutNullStreams;
      stop = () => {
        child.kill("SIGTERM");
      };
      input = (code) => {
        child.stdin.write(win ? JSON.stringify({ text: code + "\r" }) + "\n" : code + "\n");
      };
      let output = "",
        pending: any = null,
        last = "";
      const consume = (chunk: Buffer) => {
        output = (output + chunk.toString())
          .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
          .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
          .slice(-20000);
        const urls = output.match(/https:\/\/[^\s<>"\x00-\x1f]+/g) || [];
        const url = urls.find((x) => {
          try {
            const host = new URL(x).hostname;
            return acp
              ? hosts.has(host)
              : /^(?:claude\.(?:ai|com)|console\.anthropic\.com|platform\.claude\.com)$/.test(
                  host,
                );
          } catch {
            return false;
          }
        });
        if (!url) return;
        const code = output.match(/\b[A-Z0-9]{4}[- ][A-Z0-9]{4}\b/)?.[0];
        const data = {
          status: "waiting",
          url,
          userCode: code,
          needsInput: profile.agent === "claude",
          message:
            profile.agent === "claude"
              ? turnT()("server-turns.login.pasteCode")
              : harnessText(acp!, "loginMessage", turnT()),
        };
        const encoded = JSON.stringify(data);
        if (encoded !== last) {
          last = encoded;
          pending = data;
        }
      };
      if (win) {
        let partial = "";
        child.stdout.on("data", (chunk: Buffer) => {
          partial += chunk.toString("utf8");
          let i;
          while ((i = partial.indexOf("\n")) >= 0) {
            const line = partial.slice(0, i);
            partial = partial.slice(i + 1);
            try {
              const m = JSON.parse(line);
              if (typeof m.data === "string") consume(Buffer.from(m.data, "base64"));
            } catch {}
          }
        });
      } else child.stdout.on("data", consume);
      child.stderr.on("data", consume);
      child.stdin.on("error", () => {});
      let exited = false,
        exitCode: number | null = null,
        spawnError: Error | undefined;
      child.on("error", (e) => {
        spawnError = e;
        exited = true;
      });
      child.on("exit", (code) => {
        exitCode = code;
        exited = true;
      });
      while (!exited && !controller.signal.aborted) {
        if (pending) {
          const data = pending;
          pending = null;
          await post("update", data);
        }
        await sleep(150);
      }
      if (controller.signal.aborted) throw Error(turnT()("server-turns.login.cancelledOrExpired"));
      if (spawnError) throw spawnError;
      if (exitCode !== 0)
        throw Error(turnT()("server-turns.login.exited", { code: String(exitCode) }));
      if (profile.agent === "claude") {
        const check = await promisify(execFile)(
          ...resolveSpawn(command, ["auth", "status", "--json"], env),
          { cwd, env, timeout: 10000 },
        );
        const auth = JSON.parse(check.stdout);
        if (!auth.loggedIn || /api[_-]?key/i.test(auth.authMethod || ""))
          throw Error(turnT()("server-turns.login.claudeUnconfirmed"));
      }
    }
    await post("update", {
      status: "complete",
      message: turnT()("server-turns.login.done"),
    });
  } catch (e: any) {
    try {
      await post("update", {
        status: "error",
        message: restartAborted(signal)
          ? restartLoginError()
          : controller.signal.aborted
            ? turnT()("server-turns.login.cancelledOrExpired")
            : String(e.message)
                .replace(/https?:\/\/\S+/g, turnT()("server-turns.login.urlRedacted"))
                .slice(0, 1500),
      });
    } catch {}
  } finally {
    ended = true;
    clearInterval(timer);
    clearTimeout(expiry);
    signal.removeEventListener("abort", abort);
    stop();
  }
}
