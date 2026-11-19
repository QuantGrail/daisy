import { turnT } from "../harness/model-switch.ts";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { resolveSpawn } from "../platform/spawn.ts";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { JsonProcess } from "./transport.ts";
import {
  agentEnv,
  abortableProcess,
  liveFeatures,
  type Runtime,
} from "../harness/shared.ts";
import {
  forkTitle,
  nativeTitle,
} from "../../../contracts/src/title.ts";
import { runCodex } from "../harness/codex.ts";
import {
  acpHarness,
  agentCommand,
} from "../../../contracts/src/acp-harnesses.ts";
import {
  acpInitialize,
  declaresFork,
  reopenSession,
} from "../harness/acp.ts";
import {
  applyRewindFiles,
  conflictMessage,
  dropCheckpointsFrom,
  missingMessage,
  planRewindFiles,
  unrestorableMessage,
} from "./file-checkpoints.ts";
import {
  assertManaged,
  readConfiguration,
  saveConfiguration,
  redactConfig,
  localSkills,
  saveSkill,
} from "./configuration.ts";
const bin = (agent: string) => agentCommand(agent);
const exec = promisify(execFile);
async function cli(rt: Runtime, args: string[]) {
  const { stdout } = await exec(...resolveSpawn(bin(rt.job.session.agent), args, agentEnv(rt.job)), {
    cwd: rt.cwd,
    env: agentEnv(rt.job),
    timeout: 90000,
    maxBuffer: 1024 * 1024,
    signal: rt.signal,
  });
  try {
    return JSON.parse(stdout);
  } catch {
    return { output: stdout };
  }
}
function name(value: any) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.startsWith("-") ||
    /[\x00-\x1f]/.test(value) ||
    value.length > 300
  )
    throw Error(turnT()("server-turns.op.badName"));
  return value;
}
// Resolved here, not from the child's cwd: the session's workspace has no
// node_modules (`--import tsx` there fails with ERR_MODULE_NOT_FOUND).
const TSX = import.meta.resolve("tsx");
async function claudeFork(rt: Runtime, count?: number, beforeUuid?: string) {
  const sid = rt.job.operation?.args?.sourceNativeId || rt.job.session.nativeId;
  const child = execFile(
    process.execPath,
    ["--import", TSX, fileURLToPath(new URL("./claude-session.ts", import.meta.url))],
    {
      cwd: rt.cwd,
      env: agentEnv(rt.job),
      timeout: 30000,
      maxBuffer: 1024 * 1024,
      signal: rt.signal,
    },
  );
  const output = await new Promise<string>((resolve, reject) => {
    let out = "",
      err = "";
    child.stdout?.on("data", (x) => (out += x));
    child.stderr?.on("data", (x) => (err += x));
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve(out) : reject(Error(err.slice(-2000))),
    );
    child.stdin?.end(
      JSON.stringify({
        sessionId: sid,
        cwd: rt.cwd,
        count,
        beforeUuid,
        title: forkTitle(rt.job.session, count !== undefined),
      }),
    );
  });
  const result = JSON.parse(output);
  rt.emit("native", {
    nativeId: result.sessionId || "",
    contextDelivered: !!result.sessionId,
  });
  await rt.flush();
  return result;
}
export async function runOperation(rt: Runtime): Promise<any> {
  const op = rt.job.operation!;
  const args = op.args || {};
  const agent = rt.job.session.agent;
  // P4-10: an ACP harness (acp-harnesses.ts) — Kimi and the others alike.
  const acp = acpHarness(agent);
  if (op.name === "config.read") {
    const c = readConfiguration(rt);
    return {
      value: redactConfig(c.value),
      version: c.version,
      path: c.file,
      format: c.format,
      writable: !!rt.managedIdentity,
    };
  }
  if (op.name === "config.write")
    return saveConfiguration(rt, args.value, args.version);
  if (op.name === "skill.write")
    return saveSkill(rt, name(args.name), String(args.content || ""));
  if (["mcp.add", "mcp.remove"].includes(op.name)) {
    assertManaged(rt);
    const server = name(args.name);
    if (agent === "claude")
      return cli(
        rt,
        op.name === "mcp.add"
          ? [
              "mcp",
              "add-json",
              "--scope",
              "user",
              server,
              JSON.stringify(args.config),
            ]
          : ["mcp", "remove", "--scope", "user", server],
      );
    const c = readConfiguration(rt, acp ? "mcp" : "main"),
      key = agent === "codex" ? "mcp_servers" : "mcpServers";
    c.value[key] ??= {};
    if (op.name === "mcp.add") {
      if (
        !args.config ||
        typeof args.config !== "object" ||
        Array.isArray(args.config)
      )
        throw Error(turnT()("server-turns.op.mcpNotObject"));
      c.value[key][server] = args.config;
    } else delete c.value[key][server];
    return saveConfiguration(rt, c.value, c.version, acp ? "mcp" : "main");
  }
  if (agent === "claude" && ["fork", "rewind"].includes(op.name))
    return claudeFork(
      rt,
      op.name === "rewind" ? Number(args.count || 1) : undefined,
      op.name === "rewind" && typeof args.beforeUuid === "string"
        ? args.beforeUuid
        : undefined,
    );
  if (
    agent === "claude" &&
    ["plugins", "plugin.install", "plugin.uninstall"].includes(op.name)
  ) {
    if (op.name !== "plugins") assertManaged(rt);
    return redactConfig(
      await cli(
        rt,
        op.name === "plugins"
          ? ["plugin", "list", "--json"]
          : [
              "plugin",
              op.name === "plugin.install" ? "install" : "uninstall",
              "--scope",
              "user",
              name(args.name),
              ...(op.name === "plugin.install" ? ["--json"] : []),
            ],
      ),
    );
  }
  if (acp && ["plugins", "plugin.install", "plugin.uninstall"].includes(op.name))
    throw Error(
      turnT()("server-turns.op.acpNoPlugins", { short: acp.short }),
    );
  if (acp && op.name === "skills") return { skills: localSkills(rt) };
  if (acp && op.name === "mcp") {
    const c = readConfiguration(rt, "mcp");
    return redactConfig(c.value.mcpServers || {});
  }
  if (agent === "codex" && op.name === "review") {
    await runCodex(rt);
    return { completed: true };
  }
  const p = new JsonProcess(
    bin(agent),
    agent === "codex"
      ? ["app-server"]
      : acp
        ? [...acp.launch.args]
        : [
            "-p",
            "--verbose",
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--permission-prompt-tool",
            "stdio",
            ...(rt.job.session.nativeId
              ? ["--resume", rt.job.session.nativeId]
              : []),
          ],
    { cwd: rt.cwd, env: agentEnv(rt.job) },
  );
  const cleanup = abortableProcess(rt, p);
  let commands: any[] = [],
    configOptions: any[] = [],
    modes: any;
  let receivedCommands!: () => void;
  const commandNotice = new Promise<void>((resolve) => {
    receivedCommands = resolve;
  });
  p.onMessage = (m) => {
    if (m.method === "session/update") {
      const u = m.params?.update;
      if (u?.sessionUpdate === "available_commands_update") {
        commands = u.availableCommands || [];
        receivedCommands();
      }
      if (u?.sessionUpdate === "config_option_update")
        configOptions = u.configOptions || [];
    }
    if (m.id !== undefined && m.method)
      p.reject(m.id, turnT()("server-turns.op.noToolRequests"));
    if (m.type === "control_request")
      p.send({
        type: "control_response",
        response: {
          subtype: "error",
          request_id: m.request_id,
          error: turnT()("server-turns.op.noModelTools"),
        },
      });
  };
  try {
    if (agent === "codex") {
      await p.request("initialize", {
        clientInfo: { name: "daisy", version: "0.3.0" },
        capabilities: { experimentalApi: true },
      });
      p.send({ method: "initialized", params: {} });
      if (["models", "catalog"].includes(op.name)) {
        const [models, skills] = await Promise.all([
          p.request("model/list", { limit: 100 }),
          p.request("skills/list", { cwds: [rt.cwd], forceReload: true }),
        ]);
        return {
          models: models.data,
          skills: skills.data,
          commands: (skills.data || []).flatMap((group: any) =>
            (group.skills || []).map((x: any) => ({
              name: x.name,
              title: x.name,
              description: x.description || "",
              kind: "prompt",
              path: x.path,
            })),
          ),
          writable: !!rt.managedIdentity,
        };
      }
      if (op.name === "skills")
        return await p.request("skills/list", {
          cwds: [rt.cwd],
          forceReload: true,
        });
      if (op.name === "mcp")
        return redactConfig(
          await p.request("mcpServerStatus/list", { limit: 100 }),
        );
      if (op.name === "plugins")
        return redactConfig(
          await p.request("plugin/installed", { cwds: [rt.cwd] }),
        );
      if (op.name === "plugin.install" || op.name === "plugin.uninstall") {
        assertManaged(rt);
        return await p.request(
          op.name === "plugin.install" ? "plugin/install" : "plugin/uninstall",
          op.name === "plugin.install"
            ? {
                pluginName: name(args.name),
                ...(args.marketplace
                  ? { remoteMarketplaceName: name(args.marketplace) }
                  : {}),
              }
            : { pluginId: name(args.name) },
        );
      }
      const source = args.sourceNativeId || rt.job.session.nativeId;
      if (!source) throw Error(turnT()("server-turns.op.noNativeSession"));
      if (op.name === "fork") {
        const r = await p.request("thread/fork", {
          threadId: source,
          cwd: rt.cwd,
          modelProvider: "openai",
          excludeTurns: true,
          ...(args.lastTurnId ? { lastTurnId: args.lastTurnId } : {}),
        });
        // the copy carries the new session's own title — also a
        // placeholder (re-review L-e) — never the source's name, which would
        // come back as the owner's rename. Equal to Daisy's, it is ignored.
        if (liveFeatures("codex")?.title?.sync === "native") {
          const name = nativeTitle(rt.job.session.title);
          if (name)
            await p
              .request("thread/name/set", { threadId: r.thread.id, name }, 5000)
              .catch(() => {});
        }
        rt.emit("native", { nativeId: r.thread.id, contextDelivered: true });
        await rt.flush();
        return { nativeId: r.thread.id };
      }
      await p.request("thread/resume", {
        threadId: source,
        cwd: rt.cwd,
        modelProvider: "openai",
        excludeTurns: true,
      });
      if (op.name === "rewind") {
        // Newest first, until `stop` (or `count` turns) is reached.
        const turns: string[] = [];
        let cursor: string | undefined;
        const stopAt = args.beforeTurnId as string | undefined;
        const want = Number(args.count || 1);
        do {
          const page = await p.request("thread/turns/list", {
            threadId: source,
            limit: 100,
            sortDirection: "desc",
            itemsView: "notLoaded",
            ...(cursor ? { cursor } : {}),
          });
          turns.push(...(page.data || []).map((t: any) => String(t.id)));
          cursor = page.nextCursor;
        } while (
          cursor &&
          turns.length < 5000 &&
          (stopAt ? !turns.includes(stopAt) : turns.length < want)
        );
        const before = stopAt ?? turns[want - 1];
        if (!before) throw Error(turnT()("server-turns.rewind.tooMany"));
        // The native turns the rewind removes, oldest first (each
        // must have a checkpoint; null: Codex did not list `before`).
        const at = turns.indexOf(before);
        const rewound = at >= 0 ? turns.slice(0, at + 1).reverse() : [before];
        // the files from Daisy's checkpoints — planned first
        // (every byte read and verified); a file changed after the AI's
        // edit, or a rewound turn without a checkpoint, refuses the whole
        // rewind (nothing changed yet); then the history (native), then
        // the files.
        const plan =
          args.files === true
            ? await planRewindFiles(rt.job.session.id, rt.cwd, before, rewound)
            : null;
        const refuse = (message: string, extra: any) =>
          Object.assign(Error(message), {
            files: { reverted: false, via: "fallback", ...extra },
          });
        // Re-review: Codex did not list that turn — which turns the rewind
        // removes is not known, so neither are their files.
        if (plan && plan.reason !== "unsupported" && at < 0)
          throw refuse(
            turnT()("server-turns.rewind.codexNotListed"),
            {
              reason: "no-checkpoint",
              missing: [{ turnId: before, why: "not-listed" }],
            },
          );
        if (plan?.conflicts.length)
          throw refuse(conflictMessage(plan), {
            reason: "conflict",
            conflicts: plan.conflicts,
          });
        if (plan?.missing.length)
          throw refuse(missingMessage(plan), {
            reason: "no-checkpoint",
            missing: plan.missing,
          });
        // Re-review M-2: never a partial restore of the AI's files.
        if (plan?.unrestorable.length)
          throw refuse(unrestorableMessage(plan), {
            reason: "unrestorable",
            notRestored: plan.unrestorable,
          });
        const r = await p.request("thread/revert", {
          threadId: source,
          beforeTurnId: before,
        });
        let complete = true;
        let files: any = { reverted: false, reason: "not-asked" };
        if (plan && plan.reason && !plan.restore.length)
          files = {
            reverted: false,
            via: "fallback",
            reason: plan.reason,
            ...(plan.notRestored.length
              ? { notRestored: plan.notRestored }
              : {}),
            ...(plan.othersCount
              ? { others: plan.others, othersCount: plan.othersCount }
              : {}),
          };
        else if (plan) {
          const { complete: all, ...done } = await applyRewindFiles(plan);
          complete = all;
          files = done;
        }
        // Those turns are gone from the conversation: so are their
        // checkpoints — kept when a planned file could not be restored
        // (an earlier rewind still sees what those turns changed).
        if (complete)
          await dropCheckpointsFrom(rt.job.session.id, before, rewound);
        // Real Codex answers thread/revert with the whole thread (rollout
        // path, injected prompt preview, gitInfo): keep only its id — the
        // result is stored and shown to clients.
        return { thread: { id: r?.thread?.id ?? source }, files };
      }
    } else if (agent === "claude") {
      const init = await p.control({
        subtype: "initialize",
        hooks: {},
        sdkMcpServers: [],
        sdkAgents: [],
      });
      if (["catalog", "skills", "models"].includes(op.name))
        return {
          commands: (init.commands || []).map((x: any) => ({
            name: x.name,
            title: x.name,
            description: x.description || "",
            kind: "prompt",
          })),
          models: init.models || [],
          skills: localSkills(rt),
          writable: !!rt.managedIdentity,
        };
      if (op.name === "mcp")
        return redactConfig(await p.control({ subtype: "mcp_status" }));
    } else {
      const h = acp!;
      const init = await p.request("initialize", acpInitialize("0.3.0"));
      let sid = args.sourceNativeId || rt.job.session.nativeId;
      if (op.name === "fork") {
        // ACP `session/fork` is unstable: only when the harness declares it.
        if (!declaresFork(init))
          throw Error(turnT()("server-turns.op.acpNoFork", { short: h.short }));
        const r = await p.request("session/fork", {
          sessionId: sid,
          cwd: rt.cwd,
          mcpServers: [],
        });
        rt.emit("native", { nativeId: r.sessionId, contextDelivered: true });
        await rt.flush();
        return { nativeId: r.sessionId };
      }
      // P4-10: load or resume, whichever initialize declared.
      const initial = sid
        ? await reopenSession(p, init, h, sid, rt.cwd)
        : await p.request("session/new", { cwd: rt.cwd, mcpServers: [] });
      sid = initial.sessionId || sid;
      // ACP advertises commands in a notification after the session response.
      let noticeTimer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        commandNotice,
        new Promise<void>((resolve) => {
          noticeTimer = setTimeout(resolve, 1500);
        }),
      ]);
      clearTimeout(noticeTimer);
      configOptions = initial.configOptions || configOptions;
      modes = initial.modes;
      if (!rt.job.session.nativeId) {
        rt.emit("native", { nativeId: sid });
        await rt.flush();
      }
      if (["catalog", "models"].includes(op.name))
        return {
          commands: commands.map((x: any) => ({
            name: x.name,
            title: x.name,
            description: x.description || "",
            kind: "prompt",
          })),
          models:
            configOptions.find((o: any) => o.category === "model")?.options ||
            [],
          configOptions,
          modes,
          writable: !!rt.managedIdentity,
        };
      if (op.name === "rewind") {
        if (!commands.some((x) => x.name === "undo"))
          throw Error(turnT()("server-turns.op.acpNoUndo", { short: h.short }));
        return await p.request("session/prompt", {
          sessionId: sid,
          prompt: [{ type: "text", text: `/undo ${Number(args.count || 1)}` }],
        });
      }
    }
    throw Error(turnT()("server-turns.op.unsupported"));
  } finally {
    cleanup();
    p.stop();
  }
}
