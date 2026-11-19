import { daisyEnv } from "../../contracts/src/env.ts";
import { ownerT, setOwnerDataDir } from "./platform/language.ts";
import { setProcessTranslator } from "../../contracts/src/i18n-process.ts";
import { LocalizedError } from "./app/errors.ts";
import { requestT } from "./app/language.ts";
import { Lifecycle, RESTART_CLOSE } from "./update/lifecycle.ts";
import { setInterval, clearInterval } from "node:timers";
import { terminalRoutes } from "./app/terminal.ts";
import { commandRoutes } from "./sessions/commands.ts";
import { filesystemRoutes } from "./app/filesystem.ts";
import { shellRoutes } from "./app/shell.ts";
import { daisyApprovals, type DaisyApprovals } from "./approvals/approvals.ts";
import { bypassPolicy } from "./approvals/bypass-policy.ts";
import {
  notificationWriter,
  approvalNotices,
  listNotifications,
} from "./sessions/notifications.ts";
import { eventOutlet, resolutionOf } from "./sessions/event-outlet.ts";
import {
  notificationPreferences,
  notificationPreferenceRoutes,
} from "./sessions/notification-preferences.ts";
import { askSidecars } from "./sessions/ask-sidecar.ts";
import { wakeDelivery } from "./sessions/wake-delivery.ts";
import { nativeApprovalHandled } from "./approvals/native-approvals.ts";
import { backgroundRoutes } from "./schedule/background-tasks.ts";
import { liveRoutes } from "./sessions/live.ts";
import { schedulerLimits, schedulerRoutes } from "./schedule/scheduler.ts";
import { promptLayerRoutes } from "./prompts/prompt-layers.ts";
import { toolsFor } from "./tools/daisy-tools.ts";
import { toolId, toolNamesFor } from "../../contracts/src/native-tools.ts";
import { LIVE_CLOSE } from "../../contracts/src/live.ts";
import { loadServerPlugins } from "./plugins/server.ts";
import { autoCompactRoutes } from "./sessions/auto-compact.ts";
import Fastify from "fastify";
import staticPlugin from "@fastify/static";
import { existsSync } from "node:fs";
import { authRoutes } from "./app/auth.ts";
import { Store } from "./store/index.ts";
import {
  EVENTS_RESET_CODE,
  HostBrandingSchema,
  notificationAlert,
} from "../../contracts/src/index.ts";
import { api } from "../../contracts/src/api/index.ts";
import { serve } from "./app/serve.ts";
// P1-00: createApp's routes and helpers, by domain.
import type {
  AppBase,
  AppContext,
  AppOptions,
  LateServices,
} from "./app/context.ts";
import { httpHelpers, setupHttp, registerHealthRoute } from "./app/http.ts";
import { ownerHelpers } from "./app/owner.ts";
import { setupAccess } from "./access/index.ts";
import { registerAccessRoutes } from "./access/routes.ts";
import { registerIssuerRoutes } from "./access/issuer-routes.ts";
import { registerAiTokenRoutes } from "./access/ai-token-routes.ts";
import { registerContactRoutes } from "./contacts/routes.ts";
import { registerInvokeRoutes } from "./invoke/routes.ts";
import { A2AServer } from "./a2a/server.ts";
import { registerA2ARoutes } from "./a2a/routes.ts";
import { AskAct, registerAskActRoutes } from "./a2a/ask-act.ts";
import { PublicAgents, registerPublicAgentRoutes } from "./a2a/public-agents.ts";
import { ResidentAgents } from "./resident/agents.ts";
import { registerResidentRoutes } from "./resident/routes.ts";
import { A2AOutgoing } from "./a2a/outgoing.ts";
import { registerOutgoingRoutes } from "./a2a/outgoing-routes.ts";
import { registerVisitorTokenRoutes } from "./access/visitor-token-routes.ts";
import { registerDeviceRoutes } from "./access/device-routes.ts";
import { registerAgentsOverviewRoute } from "./invoke/agents-overview.ts";
import { tagFace } from "./access/faces.ts";
import { Relay } from "./relay/index.ts";
import { registerRelayRoutes } from "./relay/routes.ts";
import { bootstrapFirstStart, ensureHostLogins } from "./app/bootstrap.ts";
import {
  sessionAccess,
  sessionHelpers,
  registerSessionRoutes,
} from "./app/sessions.ts";
import { eventBus, registerLiveSocket } from "./app/events.ts";
import { queueCore } from "./app/queue.ts";
import { nodeAccess, startPresenceSweep } from "./app/nodes.ts";
import { profileHelpers, registerProfileRoutes } from "./app/profiles.ts";
import { registerWorkspaceRoutes } from "./app/workspaces.ts";
import { registerIdentitySwitchRoutes } from "./app/identity-switch.ts";
import { messageHelpers, registerMessageRoutes } from "./app/messages.ts";
import { registerAttachmentRoutes } from "./app/attachments.ts";
import { titleHelpers } from "./app/titles.ts";
import { jobPayloadHelpers } from "./app/job-payload.ts";
import { runnerHelpers, registerRunnerCalls } from "./app/runner-api.ts";
import { RunnerPort, type RunnerCall } from "./app/runner-port.ts";
import { registerUpdateRoutes } from "./app/update.ts";
import { registerAutostartRoutes } from "./app/autostart.ts";
import { registerLanguageRoutes } from "./app/language.ts";
import { ProcessRestart } from "./update/restart.ts";
import type { PackageUpdate } from "./update/package.ts";
import { registerPinRoutes } from "./app/pin.ts";
import { createPinService } from "./access/pin.ts";
import { HttpError } from "./app/errors.ts";
import { OWNER_ID, ownerUser } from "./access/owner.ts";
import { callCardOf } from "./invoke/invoke-access.ts";
import { installRequestAudit, installRequestTrace } from "./observe/request-audit.ts";
import { runnerTrace } from "./observe/runner-trace.ts";
import { registerObserveRoutes } from "./observe/routes.ts";
import { log } from "./observe/log.ts";
export { HttpError };
export type { AppOptions } from "./app/context.ts";
/** D-36: why an AI turn does not start (the owner's language; a request answers `server.pin.aiTurnsNeedPin` in its own). */
export const aiTurnsNeedPin = (): string => ownerT()("server.pin.aiTurnsNeedPin");
export async function createApp(opts: AppOptions) {
  const lifecycle = opts.lifecycle ?? new Lifecycle();
  const branding =
    opts.branding === undefined || opts.branding === null
      ? undefined
      : HostBrandingSchema.parse(opts.branding);
  // P6-23b: the owner's language for what the server says outside a request.
  setOwnerDataDir(opts.dataDir);
  // …and the shared A2A client's words (card lines, peer errors) follow it too.
  setProcessTranslator(() => ownerT());
  const store = new Store(opts.dataDir);
  // P1-02: the Runner's calls, in process (were POST /api/runner/*).
  const runnerPort = new RunnerPort();
  const restart = opts.restart ?? new ProcessRestart();
  // P1-05: the PIN. D-36: until one is set no AI turn starts (tests that
  // are not about it turn the gate off).
  const pin = createPinService(store);
  const pinGate = opts.pinGate ?? true;
  const aiTurnsBlocked = () =>
    pinGate && !pin.status().set ? aiTurnsNeedPin() : null;
  // P1-10: plugins (off by default) — imported before anything is set up,
  // so a misconfigured one stops start-up here.
  let plugins: Awaited<ReturnType<typeof loadServerPlugins>>;
  try {
    plugins = await loadServerPlugins(opts.plugins, { store });
  } catch (e) {
    store.close();
    throw e;
  }
  // P1-03: no gateway in front any more — nobody may set X-Forwarded-For.
  const app = Fastify({
    logger: false,
    bodyLimit: 12 * 1024 * 1024,
    trustProxy: false,
  });
  // P1-03: whatever this server accepts is the local face (main.ts binds
  // it to 127.0.0.1); the outside face's listener tags its own (faces.ts).
  tagFace(app.server, "local");
  // P1-06 (ADR-107): every route as registered, with the definition it
  // was registered from (a test: no `/api/*` route outside the table).
  const registered: { method: string; url: string; api?: string }[] = [];
  app.addHook("onRoute", (r) => {
    for (const method of [r.method].flat())
      if (method !== "HEAD")
        registered.push({
          method,
          url: r.url,
          ...((r.config as any)?.api ? { api: (r.config as any).api.id } : {}),
        });
  });
  // P1-03 (ADR-110): credentials, the two faces, and the guard — the one
  // place that decides who gets through (installed before every other
  // hook: rate limits, the routes).
  let access: Awaited<ReturnType<typeof setupAccess>>;
  try {
    access = await setupAccess(app, store, {
      dataDir: opts.dataDir,
      // P1-05's PIN; tests may put a stand-in (or, `null`, none: every
      // `pin: true` route is then refused — fail closed).
      ...(opts.pin === null ? {} : { pin: opts.pin ?? pin }),
      ...(opts.sharedHost ? { sharedHost: opts.sharedHost } : {}),
      ...(opts.peerIsOwner ? { peerIsOwner: opts.peerIsOwner } : {}),
    });
  } catch (e) {
    store.close();
    throw e;
  }
  // P1-11 (原则 7, S-4): the trace of every request, set before the guard
  // so its refusals carry it; every action audited once, when answered.
  installRequestTrace(app);
  access.guard.install(app);
  installRequestAudit(app, store);
  runnerPort.observer = runnerTrace(store);
  /** the unified approvals. */
  let approvalsHub: DaisyApprovals | undefined;
  /** no bypassPermissions for an AI others can reach. */
  let bypass: ReturnType<typeof bypassPolicy> | undefined;
  // P1-00: the route modules under app/ share one context — this state,
  // the helpers each module contributes (in dependency order), and the
  // services set up further down, read through getters when used.
  const shared: AppBase & LateServices = {
    opts,
    app,
    store,
    lifecycle,
    branding,
    access,
    plugins,
    runnerPort,
    restart,
    pin,
    aiTurnsBlocked,
    get shell() {
      return shell;
    },
    get live() {
      return live;
    },
    get notifications() {
      return notifications;
    },
    get scheduler() {
      return scheduler;
    },
    get promptLayers() {
      return promptLayers;
    },
    get sidecars() {
      return sidecars;
    },
    get wakes() {
      return wakes;
    },
    get commands() {
      return commands;
    },
    get approvalsHub() {
      return approvalsHub;
    },
    get bypass() {
      return bypass;
    },
  };
  const ctx = shared as AppContext;
  Object.assign(ctx, httpHelpers());
  Object.assign(ctx, ownerHelpers());
  Object.assign(ctx, sessionAccess(ctx));
  Object.assign(ctx, eventBus(ctx));
  Object.assign(ctx, queueCore(ctx));
  Object.assign(ctx, nodeAccess(ctx));
  Object.assign(ctx, profileHelpers(ctx));
  Object.assign(ctx, runnerHelpers(ctx));
  Object.assign(ctx, sessionHelpers(ctx));
  Object.assign(ctx, messageHelpers(ctx));
  Object.assign(ctx, titleHelpers(ctx));
  Object.assign(ctx, jobPayloadHelpers(ctx));
  const {
    user,
    session,
    peers,
    publish,
    broadcast,
    touched,
    stopWork,
    tidyAppends,
    settle,
    reap,
    usableNode,
    claimingNode,
    node,
    liveNudge,
    ownedJob,
    createSession,
    answerNative,
    jobPayload,
  } = ctx;
  await setupHttp(app, ctx);
  bootstrapFirstStart(ctx);
  // P6-11: a harness that appeared since gets its 「主机登录」 identity.
  ensureHostLogins(ctx);
  registerHealthRoute(app, ctx);
  registerAccessRoutes(app, store, access);
  registerIssuerRoutes(app, store, access);
  // P5-03 (ADR-142): pairing the owner's other devices; a revoked device's
  // live sockets close at once (not at the next change).
  registerDeviceRoutes(app, store, access);
  access.devices.onRevoked((ids) =>
    ctx.closeSockets(
      (p) => !!p.principal.deviceId && (ids === null || ids.includes(p.principal.deviceId)),
      "Device revoked",
      LIVE_CLOSE.deviceRevoked,
    ),
  );
  registerAiTokenRoutes(app, access);
  registerContactRoutes(app, store, access);
  // P5-02 (ADR-144): the relay — its connection, the relay address's
  // certificate, the TLS binding claim. A PIN reset turns it off with the
  // outside face (both let the world reach it).
  const relay = new Relay({
    dataDir: opts.dataDir,
    self: access.ai.self,
    faces: access.faces,
    ...(opts.relay?.transport ? { transport: opts.relay.transport } : {}),
    ...(opts.relay?.limits ? { limits: opts.relay.limits } : {}),
  });
  access.relayAddress = () => relay.address();
  registerRelayRoutes(app, store, access, relay);
  access.revocations.register(
    "external-face",
    "relay/index.ts: the relay — off, its streams end (P5-02)",
    () => {
      const had = relay.config().enabled ? 1 : 0;
      // Review L-2: saved off or the reset fails; disconnected either way;
      // the outside face's web sessions go (as with the outside face).
      void relay.offNow().catch(() => {});
      access.web.drop("external");
      return had;
    },
    { outside: true },
  );
  // P4-03 (ADR-122): call authorization — grants, ranges, call cards.
  registerInvokeRoutes(app, access.invoke);
  // Every session is an agent id the range can be set for; private unless
  // the owner made it public (P4-06's resolver, registered later, is asked first).
  access.invoke.agents.add((agentId) => {
    const s = store.session(agentId);
    return s && !s.deleting ? { id: s.id, kind: "private", name: s.title || s.id, sessionId: s.id } : null;
  });
  // P4-04 (ADR-123): the A2A server — visiting conversations and tasks on
  // top of the call authorization; executors come from P4-05 / P4-07.
  const a2a = new A2AServer(store, access.invoke);
  await registerA2ARoutes(app, a2a);
  // P4-05 (ADR-124): 问与办 — the public agents' executor (P4-06 resolves
  // which agents are public) and the owner's 是否允许办 / 办的权限模式.
  const askAct = new AskAct(ctx, access.invoke);
  a2a.executors.add((agent) => (askAct.handles(agent) ? askAct.executor : null));
  registerAskActRoutes(app, askAct);
  // P4-06 (ADR-125): public agents — the sessions the owner made public
  // (PIN) resolve as `kind: "public"` (asked before the private fallback),
  // are listed in the A2A directory and run by AskAct.
  const publicAgents = new PublicAgents(ctx, access.invoke, askAct);
  access.invoke.agents.add(publicAgents.resolve);
  a2a.directory.add(() => publicAgents.ids());
  registerPublicAgentRoutes(app, ctx, publicAgents);
  // P4-07 (ADR-126): resident agents — a configuration each; every visiting
  // conversation runs in a session of its own (resolver, directory,
  // executor, the reclaim of a conversation closes its session).
  const residents = new ResidentAgents(ctx, access.invoke);
  access.invoke.agents.add((agentId) => residents.resolve(agentId));
  a2a.directory.add(() => residents.ids());
  a2a.executors.add((agent) => (residents.handles(agent) ? residents.executor : null));
  a2a.onReclaim((contexts) => void residents.reclaimed(contexts));
  registerResidentRoutes(app, ctx, residents);
  // P4-12 (ADR-132): `daisy token` (tokens for third-party A2A clients), the
  // agents others may call (one list), and what my AIs called.
  registerVisitorTokenRoutes(app, access.visitorTokens);
  registerAgentsOverviewRoute(app, {
    store,
    invoke: access.invoke,
    publicIds: () => publicAgents.ids(),
    actOf: (id, harness) => askAct.settings(id, harness).act,
    residents: () => residents.list(),
  });
  registerOutgoingRoutes(app, store);
  registerObserveRoutes(app, store);
  autoCompactRoutes(app, store, {
    user,
    nudge: (nodeId) => liveNudge.add(nodeId),
  });
  // P1-02: restart / update of this process (was 「重启」 per node).
  registerUpdateRoutes(app, ctx);
  registerPinRoutes(app, ctx);
  // P1-09: start at boot (the same logic as `daisy autostart`).
  registerAutostartRoutes(app, ctx);
  registerLanguageRoutes(app, ctx);
  registerWorkspaceRoutes(app, ctx);
  registerProfileRoutes(app, ctx);
  registerSessionRoutes(app, ctx);
  startPresenceSweep(app, ctx);
  registerIdentitySwitchRoutes(app, ctx);
  const shell = shellRoutes(
    app,
    runnerPort,
    store,
    user,
    session,
    node,
    claimingNode,
  );
  const live = liveRoutes(
    app,
    runnerPort,
    store,
    session,
    claimingNode,
    publish,
    jobPayload,
    undefined,
    // a resident over its daily budget starts no turn by itself.
    (s) => scheduler.overBudget(s),
    // a queued turn someone else started never joins a turn a
    // bypass process starts by itself.
    (s, job) => {
      if (!bypass) return true;
      const p = store.one("SELECT data FROM profiles WHERE id=?", s.profileId);
      if (!p) return true;
      const profile = JSON.parse(p.data);
      const a = bypass.forLaunch(s, profile, job),
        b = bypass.forLaunch(s, profile, { origin: "agent" });
      return (
        a.permissionMode === b.permissionMode && a.sandboxMode === b.sandboxMode
      );
    },
    // an item reported between turns — a Codex auto-review
    // refusal still makes its card; a native approval handled.
    (job, data, fresh) => {
      if (
        fresh &&
        data?.category === "interception" &&
        !store.session(job.session_id)?.sidecar
      )
        approvalsHub?.intercepted(job, data);
      nativeApprovalHandled(store, job.session_id, data?.id, data?.status);
    },
    // D-36: no AI turn while no PIN is set.
    () => ctx.aiTurnsBlocked(),
  );
  // Daisy's scheduler and 「任务常驻 Agent」.
  const notifications = notificationWriter(store);
  const scheduler = schedulerRoutes(app, store, {
    user,
    session,
    claimingNode,
    runner: runnerPort,
    broadcast,
    touched,
    leading: () => lifecycle.leading(),
    notifications,
    limits: schedulerLimits(opts.scheduler),
    dataDir: opts.dataDir,
  });
  // 「停止」 on one item of the 「后台」 list (Agent's own or Daisy's).
  backgroundRoutes(app, store, {
    session,
    user,
    cancel: (sid, scid, reason) => scheduler.cancel(sid, scid, reason),
    publish,
  });
  // the layered prompt (org core per node, a person's and a
  // session's own additions, the switch) — before the resident routes,
  // whose prompt page shows the same layers.
  // P1-10: the control plane's own read of the org core comes from a
  // plugin (hook 1); none enabled → no own read (a Runner's report, if
  // any, is the only source).
  const promptLayers = promptLayerRoutes(app, store, {
    // P6-24: the owner's language for words stored without a request.
    dataDir: opts.dataDir,
    user,
    session,
    node,
    runner: runnerPort,
    touched,
    // P1-01: no 群聊 CLI any more (the collaboration rules are not composed).
    features: [],
    ...(opts.orgCore || plugins.orgCore
      ? { orgCore: opts.orgCore ?? plugins.orgCore }
      : {}),
    ...(plugins.readOrgCore ? { readCore: plugins.readOrgCore } : {}),
    ...(opts.orgCoreMs ? { coreMs: opts.orgCoreMs } : {}),
    leading: () => lifecycle.leading(),
    ...(opts.promptApplyGapMs !== undefined
      ? { applyGapMs: opts.promptApplyGapMs }
      : {}),
    ...(Number(opts.promptPilotMax ?? daisyEnv("DAISY_PROMPT_PILOT_MAX")) > 0
      ? {
          pilotMax: Math.floor(
            Number(opts.promptPilotMax ?? daisyEnv("DAISY_PROMPT_PILOT_MAX")),
          ),
        }
      : {}),
    // The switch goes off: a compaction still in a node's queue (its
    // Runner has not claimed it) is ended; a running one is left alone.
    withdrawQueued: (jobId, why) => {
      const j = store.one("SELECT * FROM jobs WHERE id=? AND status='queued'", jobId);
      if (!j) return false;
      settle(j, "interrupted", why);
      return true;
    },
    // Alerts about the org core go out as notifications, not
    // only onto a page: 「AI 出错」 is where node trouble already goes.
    notify: (userId, key, title, subject) =>
      notifications.emit({
        userId,
        kind: "ai_failed",
        key,
        title,
        subject: subject.slice(0, 400),
        notificationId: key,
      }),
    // ADR-154: by the names this session's Runner serves them.
    tools: (s, caps) => {
      const names = toolNamesFor(s, caps);
      return toolsFor({
        ...(s.sidecar ? {} : { daisyTools: { version: 2 } }),
        session: s,
      }).map((t) => ({
        name: toolId(s.agent, t.name, names),
        description: t.description,
      }));
    },
  });
  // P1-10 hook 2: plugins take external events in and wake sessions
  // (where a plugin's callback routes are registered).
  plugins.subscribe({ app, runner: runnerPort, store, claimingNode, scheduler });
  registerMessageRoutes(app, ctx);
  registerAttachmentRoutes(app, ctx);
  registerLiveSocket(app, ctx);
  registerRunnerCalls(ctx);
  // P1-01: what stays of the collaboration module — 「只问」 sidecar storage
  // (no routing until stage 4), one-time wakes, approval notices.
  const sidecars = askSidecars(store);
  const wakes = wakeDelivery(store, {
    publish,
  });
  // P4-08 (ADR-127): this Daisy's AIs calling agents on other Daisies —
  // the harness tools' calls, polling, the answer handed back (a wake).
  const outgoing = new A2AOutgoing({
    store,
    contacts: access.contacts,
    self: access.ai.self,
    wakes,
    ownerName: () => ownerUser().username,
    ...(opts.a2aClient?.policy ? { policy: opts.a2aClient.policy } : {}),
    ...(opts.a2aClient?.limits ? { limits: opts.a2aClient.limits } : {}),
  });
  outgoing.register(runnerPort, (req) => {
    const n = claimingNode(req),
      s = store.session(req.params.sid);
    if (!s || s.deleting || s.nodeId !== n.id) throw new LocalizedError(410, "gone", "server.session.unavailable");
    // a read-only 「只问」 sidecar has no tools.
    if (s.sidecar) throw new LocalizedError(403, "sidecar_read_only", "server.sidecar.noCalls");
    return s;
  });
  outgoing.start();
  app.addHook("preClose", async () => outgoing.close());
  lifecycle.onDrain(() => outgoing.close());
  // P2-03: the event outlet. Every approval card's notice also writes its
  // event (same call, so the same transaction as the card's change).
  const outlet = eventOutlet(store, {
    source: () => access.ai.urn,
    // 给谁 (events.md §1): the owner's `sub` at the external issuer when one
    // is configured (P2-01), else this Daisy's URN (standalone).
    recipient: () => access.issuer.get()?.config.ownerSubject || access.ai.urn,
    agentName: (sid) => store.session(sid)?.title || undefined,
  });
  const notice = approvalNotices(store);
  const approvalEvent: typeof notice = (uid, cardId, state, title, sessionId) => {
    const n = notice(uid, cardId, state, title, sessionId);
    outlet.card(uid, cardId, state, title, sessionId);
    return n;
  };
  // P4-03: a call card's notice and its outlet event (有人想调用, with its
  // 7-day expiry and display names), in the card change's transaction.
  access.invoke.onCard((state, card, title) => {
    const sid = card.agent.sessionId ?? undefined;
    notice(OWNER_ID, card.id, state, title, sid);
    if (state === "pending")
      outlet.opened({
        uid: OWNER_ID,
        kind: "invocation",
        cardId: card.id,
        title,
        ...(sid ? { sessionId: sid } : {}),
        expiresAt: card.expiresAt,
        context: { agentName: card.agent.name, callerName: card.caller.name },
      });
    else outlet.resolved({ uid: OWNER_ID, cardId: card.id, state: resolutionOf(state), title });
  });
  const approvalHooks = {
    state: (_uid: string, _aid: string): string | null => null,
    resolver: (_uid: string) => (_aid: string): string | null => null,
    pending: (_uid: string): string[] => [],
  };
  approvalsHub = daisyApprovals(
    app,
    store,
    {
      actor: (req) => {
        const u = user(req);
        return { ownerId: u.id, kind: "human", id: u.id };
      },
      // P4-03: call cards (someone wants to call my agent) are listed with
      // the rest; deciding one lets someone in — the PIN route only.
      access: {
        listCards: (_a, q) =>
          access.invoke.requests(q?.status ?? "pending", q?.limit ?? 200).map((r) => callCardOf(r, ownerUser().username)),
        respondCard: (_a, aid) => {
          try {
            access.invoke.request(aid);
          } catch {
            throw new LocalizedError(404, "approval_not_found", "server.approval.notFound");
          }
          throw new LocalizedError(403, "request_needs_pin", "server.approval.requestNeedsPin", {
            path: `/api/requests/${encodeURIComponent(aid)}/decision`,
            id: aid,
          });
        },
        pendingIds: () => access.invoke.requests("pending", 200).map((r) => r.id),
      },
      approvalEvent,
      // P2-03: a harness question (AI 提问) has no notice — it is answered
      // in its conversation — but it is an outlet card.
      cardEvent: outlet.card,
      approvalHooks,
      queueWake: (sid, requestId, prompt, origin) =>
        wakes.queue(sid, requestId, prompt, origin),
      username: () => ownerUser().username,
    },
    {
      answerNative,
      publish: (sid, type, data) => publish(sid, type, data),
    },
    { cardTtlMs: opts.cardTtlMs, now: opts.clock },
  );
  // P4-06: a public session is reachable by others (never bypass).
  bypass = bypassPolicy(store, {
    isPrivate: (s) => !publicAgents.isPublic(s.id),
    notifications: notificationWriter(store),
    // A downgraded identity's online processes end now (review 2026-11-03).
    stop: (sid) => live.stop(sid),
  });
  bypass.migrate();
  // a person's notification settings (the session kinds).
  const prefs = notificationPreferences(store, plugins.notificationKinds);
  notificationPreferenceRoutes(app, store, prefs, user);
  // P1-08: the session notifications, for the local web page.
  serve(app, api.notifications.notifications, async (req: any) => {
    const q = api.notifications.notifications.query.parse(req.query ?? {});
    const uid = user(req).id;
    const p = q.device ? prefs.load(uid) : null;
    return listNotifications(
      store,
      uid,
      q,
      p && q.device
        ? (item) =>
            notificationAlert(p, {
              category: item.category,
              device: q.device!,
              op: item.op,
              expiresAt: item.expiresAt,
            })
        : undefined,
    );
  });
  // P2-03: reading the event outlet (daisy:events:read).
  serve(app, api.events.list, async (req: any, reply) => {
    const q = api.events.list.query.parse(req.query ?? {});
    // The request going away ends its wait.
    const ac = new AbortController();
    reply.raw.once("close", () => ac.abort());
    // P5-03: …and so does revoking the paired device it came from (the
    // guard then answers 401 instead of the page).
    (req.daisyRevoked as AbortSignal | undefined)?.addEventListener("abort", () => ac.abort(), { once: true });
    const r = await outlet.read(user(req).id, q, ac.signal);
    if ("reset" in r)
      return reply.code(410).send({
        error: requestT(req, opts.dataDir)("server.events.reset"),
        code: EVENTS_RESET_CODE,
        events: [],
        cursor: 0,
        hasMore: false,
        reset: true,
      });
    return r;
  });
  serve(app, api.events.snapshot, async (req: any) => outlet.snapshot(user(req).id));
  // A long poll is answered when the server closes, not held to its end.
  app.addHook("preClose", async () => outlet.close());
  lifecycle.onDrain(() => outlet.close());
  // P4-04 (原则 2, a2a-usage.md §11): A2A tasks in flight are interrupted —
  // failed, never replayed; held SendMessage connections get that answer.
  app.addHook("preClose", async () => void a2a.interruptAll());
  lifecycle.onDrain(() => void a2a.interruptAll());
  wakes.deliver();
  // Draining: every live socket reconnects to the next process,
  // which resyncs it from the client's cursors.
  lifecycle.onDrain(() => {
    for (const socket of peers.keys())
      socket.close(RESTART_CLOSE, "Server restart");
  });
  authRoutes(app, runnerPort, store, user, node, usableNode, claimingNode);
  filesystemRoutes(app, runnerPort, store, user, node, usableNode, claimingNode);
  const commands = commandRoutes(
    app,
    runnerPort,
    store,
    session,
    ownedJob,
    publish,
    { tidyAppends },
  );
  // 「立即压缩并生效」 queues the same /compact an owner would.
  promptLayers.setCompact(commands.queueCompact);
  terminalRoutes(app, runnerPort, store, session, ownedJob);
  if (opts.webDir && existsSync(opts.webDir)) {
    await app.register(staticPlugin, {
      root: opts.webDir,
      index: ["index.html"],
    });
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith("/api/")
        ? reply.code(404).send({ error: "Not found" })
        : reply.sendFile("index.html"),
    );
  }
  // A failing sweep is logged; it must never take the control plane down
  // (review 2026-10-31).
  const timer = setInterval(() => {
    try {
      reap();
    } catch (e) {
      log.error("[reap]", (e as Error)?.message || e);
    }
    // P2-03: events past their retention (throttled to once an hour).
    try {
      outlet.sweep();
    } catch (e) {
      log.error("[event-outlet]", (e as Error)?.message || e);
    }
    // P1-03: an AI's working credential ends with its turn (and is
    // renewed before it runs out in a long one).
    void access.ai
      .sweep(
        (sid, jid) =>
          !!store.one(
            "SELECT 1 FROM jobs WHERE id=? AND session_id=? AND status='running'",
            jid,
            sid,
          ),
      )
      .catch((e) => log.error("[ai-credential]", (e as Error)?.message || e));
    // P2-02: tokens fetched for an AI are dropped once expired.
    access.delegated.sweep();
    // P4-03: call cards past their seven days.
    try {
      access.invoke.sweep();
    } catch (e) {
      log.error("[invoke]", (e as Error)?.message || e);
    }
    // P4-04: visiting conversations idle past seven days.
    try {
      a2a.sweep();
    } catch (e) {
      log.error("[a2a]", (e as Error)?.message || e);
    }
  }, 5000);
  (timer as unknown as NodeJS.Timeout).unref();
  app.addHook("onClose", async () => {
    clearInterval(timer);
    await relay.halt();
    await access.faces.stopExternal();
    for (const socket of peers.keys()) socket.close();
    store.close();
  });
  return {
    app,
    store,
    publish,
    /**
     * Tests: a web session of the owner (as if the page traded a one-time
     * code) for `face`. Production pages get theirs from `daisy open`.
     */
    issueToken: (face: "local" | "external" = "local") =>
      access.web.open(face, true).token,
    /** P1-03: credentials, faces, the guard (main.ts, tests). */
    access,
    /**
     * P4-04: the A2A server — P4-05 / P4-07 register executors
     * (`a2a.executors.add`), P4-06 / P4-07 the directory (`a2a.directory.add`).
     */
    a2a,
    /** P4-05: 问与办 (settings, how a 问 runs on a session). */
    askAct,
    /** P4-06: which sessions are public agents. */
    publicAgents,
    /** P4-07: resident agents (configuration, conversations; tests). */
    residents,
    /** P4-08: the A2A client (the AIs' calls to other Daisies; tests). */
    a2aClient: outgoing,
    /** P5-02: the relay (main.ts starts it after the faces; tests). */
    relay,
    lifecycle,
    /**
     * P1-02: the Runner calls of node `nodeId`, in process (runNode's
     * `api`). P1-02b: with the database the Runner's result journal is in.
     */
    runnerApi: (nodeId: string): RunnerCall =>
      Object.assign(runnerPort.connect(nodeId), { journal: store.db }),
    /** Tests (P1-06): every HTTP route registered, with its definition's id. */
    registeredRoutes: () => registered.slice(),
    /** Tests: the registered Runner calls. */
    runnerPaths: () => runnerPort.paths(),
    /** P1-02: restart / update of this process (runNode carries it out). */
    restart,
    /** P5-06: the npm-package updater, handed in by daemon.ts (the update routes read it). */
    get packageUpdate(): PackageUpdate | undefined {
      return shared.packageUpdate;
    },
    set packageUpdate(p: PackageUpdate | undefined) {
      shared.packageUpdate = p;
    },
    /** P1-05: the PIN (P1-03 / P4-02 check grants with it). */
    pin,
    /** Tests: 「只问」 sidecars (sweep, limits). */
    sidecars,
    /** Tests: one-time wakes (P1-01). */
    wakes,
    /**
     * P2-03: the event outlet — its write points (stage 4's call cards
     * call `opened({ kind: "invocation", … })` / `resolved`), reading, sweep.
     */
    events: outlet,
    /** Tests: the daily budget's count. */
    turnsToday: (sid: string) => scheduler.turnsToday(sid),
    /** Tests: a Daisy wake (timer, report, callback). */
    wake: scheduler.wake,
  };
}
