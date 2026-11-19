import type { FastifyInstance } from "fastify";
import type { Store } from "../store/index.ts";
import type { Lifecycle } from "../update/lifecycle.ts";
import type { shellRoutes } from "./shell.ts";
import type { liveRoutes } from "../sessions/live.ts";
import type { notificationWriter } from "../sessions/notifications.ts";
import type { schedulerRoutes, SchedulerLimits } from "../schedule/scheduler.ts";
import type { promptLayerRoutes } from "../prompts/prompt-layers.ts";
import type {
  OrgCoreSource,
  PluginSelection,
  ServerPlugins,
} from "../plugins/server.ts";
import type { commandRoutes } from "../sessions/commands.ts";
import type { DaisyApprovals } from "../approvals/approvals.ts";
import type { bypassPolicy } from "../approvals/bypass-policy.ts";
import type { AskSidecars } from "../sessions/ask-sidecar.ts";
import type { WakeDelivery } from "../sessions/wake-delivery.ts";
import type { HostBranding } from "../../../contracts/src/index.ts";
import type { Access, PinService as AccessPinService } from "../access/index.ts";
import type { HttpHelpers } from "./http.ts";
import type { OwnerHelpers } from "./owner.ts";
import type { SessionAccess, SessionHelpers } from "./sessions.ts";
import type { EventBus } from "./events.ts";
import type { QueueCore } from "./queue.ts";
import type { NodeAccess } from "./nodes.ts";
import type { ProfileHelpers } from "./profiles.ts";
import type { RunnerHelpers } from "./runner-api.ts";
import type { RunnerPort } from "./runner-port.ts";
import type { ProcessRestart } from "../update/restart.ts";
import type { PackageUpdate } from "../update/package.ts";
import type { PinService } from "../access/pin.ts";
import type { MessageHelpers } from "./messages.ts";
import type { TitleHelpers } from "./titles.ts";
import type { JobPayloadHelpers } from "./job-payload.ts";
/** What createApp takes (P1-00: moved from its signature). */
export interface AppOptions {
  dataDir: string;
  /**
   * Tests only — never set by main.ts (P4-08, ADR-127): the A2A client's
   * outbound policy relaxed for two Daisies in one process (loopback), a
   * stand-in resolver, shorter polling.
   */
  a2aClient?: {
    policy?: import("../a2a/client/index.ts").OutboundPolicy;
    limits?: ConstructorParameters<typeof import("../a2a/outgoing.ts").A2AOutgoing>[0]["limits"];
  };
  /**
   * P5-02 tests only: the relay connection's test CA and resolver for the
   * fake domain, a test ACME server's CA, shorter backoff. Never set by main.ts.
   */
  relay?: Pick<import("../relay/index.ts").RelayDeps, "transport" | "limits">;
  /**
   * Tests: called inside 「换身份」's transaction, between its read and its
   * write (proves another writer cannot get in between).
   */
  identitySwitchHook?: (sessionId: string) => void;
  webDir?: string;
  bootstrap?: boolean;
  workspaceHome?: string;
  workspaceRoots?: string[];
  /**
   * P1-05's PIN (5.11). Absent: every route marked `pin: true` is refused
   * (P1-03 fails closed).
   */
  pin?: AccessPinService | null;
  /** Tests: the machine start-at-boot runs on (systemctl, platform; default this process's). */
  autostartHost?: import("../platform/autostart.ts").AutostartHost;
  /** Tests: is this a shared machine (the passcode's auto mode). */
  sharedHost?: () => boolean;
  /**
   * Tests: is the process at the other end of the connection the owner's
   * (a code-less web session needs it; default access/peer.ts).
   */
  peerIsOwner?: (req: any) => boolean;
  /** Requests per minute, per user / IP. */
  rateLimit?: { user?: number };
  /** First start: also create the default server node and host-login identities. */
  bootstrapLocal?: boolean;
  /**
   * A conversation's device counts as offline once its runner has not been
   * heard from this long (default 10 s, tests shorten it).
   */
  presenceMs?: number;
  /**
   * Host branding for the web app (DAISY_BRANDING): validated here, served
   * by the public /api/health. Presentation only.
   */
  branding?: unknown;
  /**
   * Drain state of this process (P1-02: only 「排空再退出」 is
   * left). Default: never draining (tests, single-process tools).
   */
  lifecycle?: Lifecycle;
  /**
   * P1-02: restarting / updating this whole process (the in-process
   * Runner's loop carries it out). Absent: a control that refuses — no
   * Runner runs here (tests that drive the Runner calls themselves).
   */
  restart?: ProcessRestart;
  /** background limits / monitor interval (default: env, then the defaults). */
  scheduler?: Partial<SchedulerLimits>;
  /**
   * P1-10: plugins to enable, with their options (absent: env
   * DAISY_PLUGINS; neither: none). See plugins.ts.
   */
  plugins?: PluginSelection;
  /**
   * `orgCoreMs`: how often the control plane reads the org core
   * itself (a plugin's, hook 1); `promptApplyGapMs`: the pause between two
   * compactions of 「立即生效」 on one node (tests shorten both).
   */
  orgCoreMs?: number;
  promptApplyGapMs?: number;
  /**
   * P4-13: which L1 document the org layer is, set here instead of by a
   * plugin (hook 1's `orgCore`; this wins). Without a plugin nothing
   * reads it: only reports a Runner sends are taken — tests use it to
   * drive the org layer with no plugin installed.
   */
  orgCore?: OrgCoreSource;
  /**
   * how many people a pilot list may cover while the control
   * plane cannot read L1 itself (default env DAISY_PROMPT_PILOT_MAX, else 5).
   */
  promptPilotMax?: number;
  /**
   * D-36: no AI turn starts while no PIN is set (new messages are refused,
   * queued work is not claimed, an online process may not start a turn by
   * itself). Default on; only tests that are not about the PIN turn it off.
   */
  pinGate?: boolean;
  /**
   * Q-1 (limits.md §1): how long a harness's tool permission / question
   * card waits for its owner before its turn ends (R-4). Default 24 h;
   * main.ts takes DAISY_CARD_TTL_HOURS.
   */
  cardTtlMs?: number;
  /** Tests: the clock card expiry reads (default Date.now). */
  clock?: () => number;
}
/**
 * P1-00: createApp's own state, shared by the modules under app/ (each
 * takes the context and destructures what it uses).
 */
export interface AppBase {
  opts: AppOptions;
  app: FastifyInstance;
  store: Store;
  lifecycle: Lifecycle;
  branding: HostBranding | undefined;
  /** P1-03: credentials, the faces, the guard. */
  access: Access;
  /** P1-10: the enabled plugins' hooks (none by default). */
  plugins: ServerPlugins;
  /** P1-02: the in-process Runner's calls (were POST /api/runner/*). */
  runnerPort: RunnerPort;
  /** P1-02: restart / update of the whole process. */
  restart: ProcessRestart;
  /**
   * P5-06: updating an npm-installed Daisy (daemon.ts sets it after
   * createApp; absent in tests that build the app alone — the update
   * routes then answer that this Daisy cannot update itself).
   */
  packageUpdate?: PackageUpdate;
  /** P1-05: the PIN (set, grant, check, local reset). */
  pin: PinService;
  /** D-36: why no AI turn may start now (no PIN set), or null. */
  aiTurnsBlocked: () => string | null;
}
/**
 * P1-00: the services createApp sets up as it goes (getters on the
 * context). Most exist only after the routes that use them are registered,
 * so a module reads them as `ctx.x` when it needs them and never
 * destructures them.
 */
export interface LateServices {
  shell: ReturnType<typeof shellRoutes>;
  live: ReturnType<typeof liveRoutes>;
  notifications: ReturnType<typeof notificationWriter>;
  scheduler: ReturnType<typeof schedulerRoutes>;
  promptLayers: ReturnType<typeof promptLayerRoutes>;
  /** 「只问」 sidecars: storage, limits, summaries (P1-01: no routing). */
  sidecars: AskSidecars;
  /** One-time wakes of an AI (P1-01: from collaboration.ts). */
  wakes: WakeDelivery;
  commands: ReturnType<typeof commandRoutes>;
  /** the unified approvals. */
  approvalsHub: DaisyApprovals | undefined;
  /** no bypassPermissions for an AI others can reach. */
  bypass: ReturnType<typeof bypassPolicy> | undefined;
}
/** Everything a route module may use (P1-00). */
export type AppContext = AppBase &
  LateServices &
  HttpHelpers &
  OwnerHelpers &
  SessionAccess &
  EventBus &
  QueueCore &
  NodeAccess &
  ProfileHelpers &
  RunnerHelpers &
  SessionHelpers &
  MessageHelpers &
  TitleHelpers &
  JobPayloadHelpers;
