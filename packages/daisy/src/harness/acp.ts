/**
 * P4-10 (plan 5.5, ADR-130): the one adapter for every harness that speaks
 * ACP v1 on stdio — Kimi Code CLI, OpenCode, Antigravity, DeepSeek Harness
 * and whatever `$DAISY_ACP_HARNESSES` adds. What differs between them is
 * data (contracts acp-harnesses.ts): the command, the declared optional
 * capabilities, the modes. What one harness supports is read from its
 * `initialize` / session answers, never from its name:
 *
 * - resume: `session/load` when `loadSession` is declared, else
 *   `session/resume` when `sessionCapabilities.resume` is (DeepSeek Harness
 *   has only the latter), else 「不支持恢复」;
 * - model / effort / mode: the session's `configOptions` by `category`
 *   (`model`, `thought_level`, `mode`) through `session/set_config_option`
 *   (`session/set_model` is gone from ACP; Kimi keeps it as an extension,
 *   used only when the session lists no model option), modes through
 *   `session/set_mode` when the session lists them;
 * - fork (operations.ts): `session/fork` only when declared.
 *
 * One process per session: the ACP session is created / resumed
 * once, each job is a `session/prompt`. Offline the process serves one turn
 * and ends.
 */
import { turnT } from "./model-switch.ts";
import { readOnlyLaunch } from "../platform/read-only.ts";
import { JsonProcess } from "../turns/transport.ts";
import type { RunnerJob } from "../../../contracts/src/index.ts";
import {
  acpHarness,
  harnessText,
  agentCommand,
  type AcpHarnessConfig,
} from "../../../contracts/src/acp-harnesses.ts";
import { AGENT_CAPABILITIES } from "../../../contracts/src/agent-capabilities.ts";
import { staticQuota } from "../turns/quota.ts";
import {
  Items,
  ContextMeter,
  agentEnv,
  asText,
  stage,
  quotaItem,
  requestedAutoCompact,
  unknownThreshold,
  oneShot,
  type LiveAgent,
  type LiveHooks,
  type MakeAgent,
  type Runtime,
  stoppedEnd,
} from "./shared.ts";

/** The `clientInfo` Daisy sends at `initialize` (P6-03: was `agent-harbor`). */
export const ACP_CLIENT_INFO = { name: "daisy", version: "0.1.0" };
/** `initialize` params: ACP protocol version 1, no client-side fs / terminal. */
export const acpInitialize = (version = ACP_CLIENT_INFO.version) => ({
  protocolVersion: 1,
  clientInfo: { ...ACP_CLIENT_INFO, version },
  clientCapabilities: {},
});
export function harnessOf(agent: string): AcpHarnessConfig {
  const h = acpHarness(agent);
  if (!h) throw Error(turnT()("server-harness.acp.noHarness", { agent }));
  return h;
}
/** Start the harness's ACP server for a session (`DAISY_<ID>_BIN` overrides the command). */
export function spawnAcp(
  h: AcpHarnessConfig,
  opts: ConstructorParameters<typeof JsonProcess>[2],
) {
  return new JsonProcess(agentCommand(h.id), [...h.launch.args], opts);
}
/**
 * Continue native session `sid`: `session/load` or `session/resume`,
 * whichever `initialize` declared (plan 5.5). The answer carries the
 * session's config options / modes, like `session/new`'s.
 */
export async function reopenSession(
  p: JsonProcess,
  init: any,
  h: AcpHarnessConfig,
  sid: string,
  cwd: string,
): Promise<any> {
  const caps = init?.agentCapabilities || {};
  const params = { sessionId: sid, cwd, mcpServers: [] };
  if (caps.loadSession) return (await p.request("session/load", params)) ?? {};
  if (caps.sessionCapabilities?.resume)
    return (await p.request("session/resume", params)) ?? {};
  throw Error(
    turnT()("server-harness.acp.noResume", { short: h.short, name: h.name }),
  );
}
/** Does the harness declare `session/fork` (unstable in ACP v1)? */
export const declaresFork = (init: any) =>
  !!init?.agentCapabilities?.sessionCapabilities?.fork;

/** The capabilities this release declares for `agent` (agent-capabilities.ts shape, ADR-131). */
export const acpCapabilities = (agent: string) => AGENT_CAPABILITIES[agent]!;

const makers = new Map<string, MakeAgent>();
/** The live-agent factory of ACP harness `agent` (turns/live.ts). */
export function acpAgentFor(agent: string): MakeAgent {
  let make = makers.get(agent);
  if (!make) {
    const h = harnessOf(agent);
    make = (first, cwd, hooks, live) => acpAgent(h, first, cwd, hooks, live);
    makers.set(agent, make);
  }
  return make;
}
/** One turn in a process that ends with it (offline mode, tests). */
export const runAcp = (rt: Runtime) =>
  oneShot(acpAgentFor(rt.job.session.agent), rt);

export function acpAgent(
  h: AcpHarnessConfig,
  first: RunnerJob,
  cwd: string,
  hooks: LiveHooks,
  live: boolean,
): LiveAgent {
  // ADR-159 §6: this process's words in its session's language (P6-24 stores it on the session).
  const T = () => turnT(first.session?.lang);
  const since = Date.now();
  const name = h.short;
  let p!: JsonProcess,
    starting: Promise<void> | null = null,
    started = false,
    closed = false,
    stopping = false,
    sid = "",
    init: any = null,
    /** The session's config options (`configOptions`, kept current by `config_option_update`). */
    options: any[] = [],
    /** The session's modes (`modes.availableModes`), when it lists them. */
    modes: any = null,
    /** The slash commands the session advertised (`available_commands_update`); null = none heard. */
    commands: Set<string> | null = null,
    applied = { model: "", effort: "", mode: "" },
    cur: Runtime | null = null,
    lastJob = first.id,
    segment = 0,
    lastKind = "",
    media: Promise<void>[] = [],
    failTurn: ((e: Error) => void) | null = null,
    interruptTimer: ReturnType<typeof setTimeout> | undefined;
  const items = new Items(
    () => cur || { job: { id: lastJob }, emit: hooks.emit },
  );
  // ACP reports no trigger point and takes no per-identity one.
  const meter = new ContextMeter(
    items,
    h.id as any,
    unknownThreshold(requestedAutoCompact(first), harnessText(h, "thresholdReason", T())),
  );
  const reverse = async (m: any) => {
    const rt = cur;
    try {
      if (m.method === "session/request_permission" && rt) {
        const x = m.params,
          d = await rt.approve(
            x.toolCall?.title || T()("server-harness.acp.tool", { name }),
            x.toolCall,
            x.options.map((o: any) => ({ id: o.optionId, label: o.name })),
            { category: "permission" },
          );
        p.respond(m.id, {
          outcome: { outcome: "selected", optionId: d.optionId },
        });
      } else p.reject(m.id, `Unsupported ACP client method ${m.method}`);
    } catch {
      if (!p.closed) p.respond(m.id, { outcome: { outcome: "cancelled" } });
    }
  };
  const onMessage = (m: any) => {
    if (m.id !== undefined && m.method) {
      void reverse(m);
      return;
    }
    agent.lastActivity = Date.now();
    if (m.method !== "session/update") return;
    const u = m.params?.update;
    if (!u) return;
    // Kept between turns too: what the next configure() can set.
    if (u.sessionUpdate === "config_option_update" && Array.isArray(u.configOptions))
      options = u.configOptions;
    if (
      u.sessionUpdate === "available_commands_update" &&
      Array.isArray(u.availableCommands)
    )
      commands = new Set(
        u.availableCommands.map((c: any) => String(c?.name || "")),
      );
    if (u.sessionUpdate === "current_mode_update" && modes)
      modes = { ...modes, currentModeId: u.currentModeId };
    if (!cur) return;
    const rt = cur;
    if (
      u.sessionUpdate === "agent_message_chunk" ||
      u.sessionUpdate === "agent_thought_chunk"
    ) {
      const kind =
        u.sessionUpdate === "agent_message_chunk" ? "assistant" : "thinking";
      if (lastKind !== kind) {
        segment++;
        lastKind = kind;
      }
      if (u.content?.type === "text")
        items.delta(`message:${segment}`, u.content.text, kind);
      else if (u.content?.type === "image" && rt.publishAttachment) {
        const key = `media:${segment++}`;
        const content = u.content;
        media.push(
          rt
            .publishAttachment(
              `${h.id}-image-${segment}`,
              content.mimeType,
              content.data,
            )
            .then((a) => {
              items.set(key, {
                kind: "assistant",
                text: "",
                attachments: [a],
                status: "complete",
              });
            }),
        );
      }
    }
    if (
      u.sessionUpdate === "tool_call" ||
      u.sessionUpdate === "tool_call_update"
    ) {
      lastKind = "tool";
      items.set(u.toolCallId, {
        kind: "tool",
        native: u,
        ...(u.title ? { name: u.title } : {}),
        ...(u.rawInput ? { input: u.rawInput } : {}),
        ...(u.content ? { text: asText(u.content) } : {}),
        status:
          u.status === "completed"
            ? "complete"
            : u.status === "failed"
              ? "error"
              : "running",
      });
    }
    // ACP usage_update: tokens used / context size.
    if (u.sessionUpdate === "usage_update") {
      const used = u.used ?? u.usage?.used,
        size = u.size ?? u.usage?.size;
      if (typeof used === "number") {
        meter.used = used;
        meter.window = typeof size === "number" ? size : null;
        meter.emit();
      }
    }
    if (
      ![
        "agent_message_chunk",
        "agent_thought_chunk",
        "tool_call",
        "tool_call_update",
      ].includes(u.sessionUpdate)
    )
      items.set(`event:${u.sessionUpdate}`, {
        kind: "tool",
        category: u.sessionUpdate === "plan" ? "plan" : "native",
        name: u.sessionUpdate,
        text: asText(u),
        native: u,
        status:
          u.sessionUpdate === "plan" &&
          !u.entries?.every((e: any) => e.status === "completed")
            ? "running"
            : "complete",
      });
  };
  const session = (r: any) => {
    if (Array.isArray(r?.configOptions)) options = r.configOptions;
    if (r?.modes && Array.isArray(r.modes.availableModes)) modes = r.modes;
  };
  const start = async (rt: Runtime) => {
    p = spawnAcp(h, {
      cwd,
      env: agentEnv(rt.job),
      readOnly: readOnlyLaunch(rt.job, cwd),
    });
    p.onMessage = onMessage;
    p.onExit = (e) => {
      const unexpected = !stopping;
      closed = true;
      clearTimeout(interruptTimer);
      if (failTurn) failTurn(e);
      else if (unexpected)
        hooks.closed(T()("server-harness.processExited", { name, error: e.message.slice(0, 200) }));
    };
    init = await p.request("initialize", acpInitialize());
    sid = rt.job.session.nativeId || "";
    if (sid) session(await reopenSession(p, init, h, sid, cwd));
    else {
      const result = await p.request("session/new", {
        cwd,
        mcpServers: [],
      });
      session(result);
      sid = result.sessionId;
      rt.emit("native", { nativeId: sid });
      await rt.flush();
    }
    started = true;
  };
  /** The session's config option of `category` (ACP `configOptions`). */
  const option = (category: string, legacyId?: string) =>
    options.find((o: any) => o?.category === category)?.id ||
    (legacyId && options.find((o: any) => o?.id === legacyId)?.id) ||
    legacyId ||
    "";
  /** Model / effort / mode for this turn, re-applied only when changed. */
  const configure = async (rt: Runtime) => {
    const want = {
      model: rt.job.profile.model || "",
      effort: rt.job.profile.reasoningEffort || "",
      // P4-05: a turn that set a mode (an A2A 「问」's read-only `plan`)
      // is followed by one that sets none — back to the harness's default,
      // never left in the previous turn's mode.
      mode:
        rt.job.profile.permissionMode ||
        (applied.mode ? h.modes.default || "" : ""),
    };
    if (want.model && want.model !== applied.model) {
      const id = option("model");
      if (id)
        await p.request("session/set_config_option", {
          sessionId: sid,
          configId: id,
          value: want.model,
        });
      else if (h.legacy?.setModel)
        await p.request("session/set_model", {
          sessionId: sid,
          modelId: want.model,
        });
      else throw Error(T()("server-harness.acp.noModel", { name }));
    }
    if (want.effort && want.effort !== applied.effort) {
      const id = option("thought_level", h.legacy?.thinkingConfigId);
      if (!id)
        throw Error(T()("server-harness.acp.noEffort", { name }));
      await p.request("session/set_config_option", {
        sessionId: sid,
        configId: id,
        value: want.effort,
      });
    }
    if (want.mode && want.mode !== applied.mode) {
      const id = option("mode");
      // A session listing its modes, or a harness declaring modes (Kimi):
      // session/set_mode; else the `mode` config option.
      if (modes || (!id && h.modes.values.length))
        await p.request("session/set_mode", {
          sessionId: sid,
          modeId: want.mode,
        });
      else if (id)
        await p.request("session/set_config_option", {
          sessionId: sid,
          configId: id,
          value: want.mode,
        });
      else throw Error(T()("server-harness.acp.noMode", { name }));
    }
    applied = want;
    if (want.model || want.effort)
      rt.emit("native", {
        nativeId: sid,
        ...(want.model ? { model: want.model } : {}),
        ...(want.effort ? { effort: want.effort } : {}),
      });
  };
  const interrupt = () => {
    if (!p || closed) return;
    if (!live || !sid) {
      stopping = true;
      p.stop();
      return;
    }
    try {
      p.send({
        jsonrpc: "2.0",
        method: "session/cancel",
        params: { sessionId: sid },
      });
    } catch {}
    clearTimeout(interruptTimer);
    interruptTimer = setTimeout(() => {
      if (cur) {
        stopping = true;
        p.stop();
      }
    }, 5000);
  };
  const agent: LiveAgent = {
    since,
    lastActivity: since,
    get closed() {
      return closed;
    },
    busy: () => !!cur,
    pending: () => [],
    stopped: () => p?.whenStopped() ?? Promise.resolve(),
    stop(reason) {
      stopping = true;
      closed = true;
      clearTimeout(interruptTimer);
      if (reason) failTurn?.(Error(reason));
      p?.stop();
    },
    nativeId: () => (started ? sid : first.session.nativeId || null),
    async turn(rt) {
      if (closed) throw Error(T()("server-harness.processEndedResend", { name }));
      if (cur) throw Error(T()("server-harness.busyOtherTurn", { name }));
      cur = rt;
      lastJob = rt.job.id;
      const quota = staticQuota(rt.job);
      if (quota) quotaItem(items, quota, rt.job.profile.label);
      segment = 0;
      lastKind = "";
      media = [];
      hooks.changed();
      const onAbort = () => interrupt();
      rt.signal.addEventListener("abort", onAbort, { once: true });
      if (rt.signal.aborted) onAbort();
      const exited = new Promise<never>((_, fail) => {
        failTurn = fail;
      });
      exited.catch(() => {});
      try {
        const reused = started;
        if (!started)
          await Promise.race([
            (starting ??= start(rt).catch((e) => {
              agent.stop();
              throw e;
            })),
            exited,
          ]);
        if (closed) throw Error(T()("server-harness.processEndedResend", { name }));
        if (rt.signal.aborted) throw Error(T()("server-harness.turn.stopped"));
        if (reused) stage(rt, "launch", T()("server-harness.stage.reused", { name }));
        await Promise.race([configure(rt), exited]);
        // P4-11 / P4-10: /compact is the agent's own command — only when
        // the session advertised it (ACP `available_commands`).
        const slash = /^\/(\S+)/.exec(rt.prompt.trim())?.[1];
        if (slash === "compact" && commands && !commands.has("compact"))
          throw Error(T()("server-harness.acp.noCompact", { name }));
        stage(rt, "session", T()("server-harness.acp.sessionReady", { name }));
        const prompt: any[] = [{ type: "text", text: rt.prompt }];
        if (init.agentCapabilities?.promptCapabilities?.image)
          for (const f of rt.files)
            if (f.mime.startsWith("image/"))
              prompt.push({ type: "image", mimeType: f.mime, data: f.data });
        const response = p.request(
          "session/prompt",
          { sessionId: sid, prompt },
          0,
        );
        // Attachment- or terminal-only messages are acknowledged too.
        if (
          rt.job.text ||
          rt.job.attachments?.length ||
          rt.job.terminal?.length
        )
          rt.emit("item", {
            id: `user:${rt.job.id}`,
            kind: "user",
            text: rt.job.text,
            status: "accepted",
            createdAt: Date.now(),
          });
        stage(rt, "sent", T()("server-harness.stage.inputSent", { name }));
        rt.emit("native", { nativeId: sid, contextDelivered: true });
        const result = await Promise.race([response, exited]);
        if (result.stopReason === "cancelled")
          throw Error(T()("server-harness.acp.cancelled", { name }));
        await Promise.all(media);
        items.finish();
        return {};
      } catch (e) {
        throw stoppedEnd(e, rt, T()("server-harness.acp.cancelled", { name }));
      } finally {
        failTurn = null;
        clearTimeout(interruptTimer);
        rt.signal.removeEventListener("abort", onAbort);
        cur = null;
        items.retain(new Set());
        agent.lastActivity = Date.now();
        hooks.changed();
      }
    },
  };
  return agent;
}
