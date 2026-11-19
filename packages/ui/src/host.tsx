import { ACP_AGENTS, agentName } from "@daisy-ai/contracts";
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { Linking } from "react-native";
import type { Attachment, Session, TaskContext } from "@daisy-ai/contracts";
import type { DaisyClient } from "@daisy-ai/client";
import { daisyTimeFormat } from "./present";
import { PRODUCT_NAME, type Translate } from "@daisy-ai/contracts";
import { t as tr, useT } from "./i18n";

/** A file chosen by the host's picker, ready to upload. */
export interface DaisyPickedFile {
  name: string;
  mimeType?: string;
  size?: number;
  /**
   * Content, as one of: raw base64 (no data: prefix), a Blob/File the UI
   * encodes, or a lazy reader (called only after the 8 MiB size check).
   */
  base64?: string;
  blob?: Blob;
  readBase64?: () => Promise<string>;
}
/** Something Daisy wants the user to keep: an attachment or a session export. */
export interface DaisyFileRequest {
  kind: "attachment" | "export";
  name: string;
  mimeType: string;
  /** Reads the content (authenticated where needed). */
  read: () => Promise<Blob>;
  /** Attachment only. */
  attachment?: Attachment;
  /** Export only: the JSON text. */
  text?: string;
}
/**
 * Optional platform hooks a host page can supply. Every member falls back to
 * Daisy's built-in implementation (DOM on web, Expo modules on native).
 */
export interface DaisyHostAdapters {
  copyText?: (text: string) => Promise<void>;
  /** Show a file picker; resolve `[]` when the user cancels. */
  pickFiles?: () => Promise<DaisyPickedFile[]>;
  /** Download / share a file. */
  saveFile?: (file: DaisyFileRequest) => Promise<void>;
  /** Open an external link (Markdown links, MCP / official login pages). */
  openUrl?: (url: string) => void | Promise<void>;
  /**
   * Open the official CLI terminal. When provided, DaisyChat calls it instead
   * of showing its own full-screen terminal modal (e.g. the host opens the full
   * Daisy web app in a new tab or iframe).
   */
  openTerminal?: (request: { sessionId: string; client: DaisyClient }) => void;
  /**
   * Open the host task a session is bound to (the task banner is clickable
   * when this is provided or the task has a `url`). Without it, DaisyChat in
   * host mode (gateway auth: empty client token) opens `task.url` in the top
   * window when it is http(s) and same-origin or in DAISY_ORIGINS; outside
   * host mode it opens the link like any external link.
   */
  openTask?: (task: TaskContext, sessionId: string) => void;
  /**
   * open the 「审批」 page (the host UI's unified inbox, or the
   * host's own), where harness permission prompts are answered — the
   * conversation only shows that one waits. Without it the card says where to go.
   */
  openApprovals?: () => void;
}
/** User-facing wording that a host may need to align with its own vocabulary. */
export interface DaisyCopy {
  /**
   * Agent display names and status labels. Status keys follow the session
   * phase: `idle` (no message sent yet), `completed` (idle after a finished
   * turn), `queued`, `running`, `waiting` (tool authorization / question),
   * `error`, `interrupted`.
   */
  labels: Record<string, string>;
  /** Badge on a pending tool-authorization card. */
  approvalBadge: string;
  /** Inline line under the transcript while waiting for authorization. */
  approvalWaiting: string;
  /** Composer status line while waiting for authorization. */
  approvalWaitingHint: string;
  /**
   * a permission card's note that it is answered on the 「审批」
   * page. Unused since D-39 (the card answers it itself); kept optional so
   * older hosts' copy objects still type-check.
   */
  approvalElsewhere?: string;
  /**
   * D-39: the permission card's secondary link to the 「审批」 page (shown
   * when the host has one). Optional for older hosts' copy objects.
   */
  approvalOpenInbox?: string;
  /** DaisyApp overview caption. */
  approvalRecords: string;
  /** Command panel note about permissive modes. */
  approvalRelaxNote: string;
  /** Collapsed record left in the conversation after an allow decision. */
  approvalAllowed: string;
  /** … after a deny / decline decision. */
  approvalDenied: string;
  /** … when the request expired unanswered (turn stopped / lease lost). */
  approvalExpired: string;
  /** Slash-command descriptions by command name (e.g. `permissions`). */
  commandDescriptions: Record<string, string>;
  composerPlaceholder: string;
  emptyTitle: string;
  emptyBody: string;
  taskBanner: string;
  footer: string;
  /** DaisyChat could not load the conversation (404). */
  loadErrorNotFound: string;
  /** … the conversation belongs to someone else (403). */
  loadErrorForbidden: string;
  /** … the sign-in expired (401). */
  loadErrorUnauthorized: string;
  /**
   * … Daisy is unreachable (network / 5xx); retried automatically.
   * `{productName}` is replaced by `productName`.
   */
  loadErrorUnavailable: string;
  /**
   * Product name wherever Daisy names itself to users (eyebrows, loading
   * and connection messages). Default PRODUCT_NAME; branding `productName`
   * replaces it.
   */
  productName: string;
  /** Status line and composer placeholder while the connection is being retried. */
  reconnecting: string;
  /** Heading of the "what will be sent" preview above the composer. */
  previewTitle: string;
  previewSame?: string;
  /** Activity track button that scrolls back to the first step. */
  traceStart: string;
  /**
   * Host page context bar above the composer (DaisyChat `context`).
   * `{label}` is replaced by the context label.
   */
  contextAttach: string;
  /** Badge on the bar when this session already carries the same context (not re-sent). */
  contextAttached: string;
  /** Expanded bar, already-attached case: why it is not sent again. */
  contextAttachedHint: string;
  /** Bar after the user closed it for the next message (`{label}`). */
  contextSkipped: string;
  /** Button that undoes 「不附带」 on the bar. */
  contextRestore: string;
  /** Accessibility label of the bar's × (skip for the next message only). */
  contextDismiss: string;
  /** Expand / collapse the context text (bar and message tag). */
  contextShow: string;
  contextHide: string;
  /** Bar note while the draft is a /command: context waits for the next message. */
  contextCommandHint: string;
  /** Small tag under a user message that carried a context (`{label}`). */
  contextTag: string;
  /** Expand a long context text in full (message tag). */
  contextShowAll: string;
  /** Bar text for ~2.5 s after the page context changed (`{label}`). */
  contextSwitched: string;
  /** Expanded bar: the host context was too long and was cut to fit. */
  contextTrimmed: string;
  /** Line shown instead of the bar when the host context is unusable (not sent). */
  contextInvalid: string;
  /** User message delivery states (small text next to 「你」). */
  userStatusQueued: string;
  userStatusAccepted: string;
  userStatusError: string;
  userStatusCancelled: string;
  /** a 立即追加 the turn did not take, sent as the next turn. */
  userStatusRequeued: string;
  userStatusAppended: string;
  /**
   * Follow-up 2026-11-09 (item `delivery`): an accepted 立即追加 the agent
   * holds but has not read (Claude: at its next tool boundary) / one it read.
   */
  userStatusHanded: string;
  userStatusRead: string;
  /**
   * Follow-up 2026-11-09: tag on an answer the agent retracted
   * (Claude refusal retry on another model); the text stays, greyed.
   */
  messageRetracted: string;
  /** 「插队发送」 would stop running subagents ({count}). */
  jumpSubagentsWarning: string;
  jumpAfterTurn: string;
  jumpAnyway: string;
  /** Composer status line: connecting / sending / idle before the first turn / idle after it. */
  connectingStatus: string;
  sendingStatus: string;
  idleStatus: string;
  resumableStatus: string;
  /**
   * What the conversation shows vs the server: nothing yet (after
   * 150 ms), a kept / announced-older view being brought up to date, and the
   * server unreachable (`{age}` = 「3 分钟前」).
   */
  loadingStatus: string;
  syncingStatus: string;
  offlineContent: string;
  /** The AI has to start before it answers (queued / claimed, no output yet). */
  aiOnlining: string;
  /** The conversation's device (runner) is not connected; `{label}` = its name. */
  deviceOffline: string;
  /** … and a message waits for it. */
  deviceOfflineQueued: string;
  /** Transcript line while the Agent works (full chrome only). */
  runningNotice: string;
  /** Activity track (`{done}` `{total}` `{count}` `{tools}` `{step}` placeholders). */
  traceTitle: string;
  traceProgress: string;
  traceActive: string;
  traceInterrupted: string;
  traceExpand: string;
  traceCollapse: string;
  /**
   * @deprecated Unused since review r2: the compact summary lists what the
   * Agent did (`traceRanCommand` …) instead of counting tools.
   */
  traceSummaryTools: string;
  traceSummarySteps: string;
  traceSummaryRunning: string;
  /** compact summary while the turn runs and no tool is active. */
  traceWorking: string;
  /** compact summary phrases: `{command}`; `{tool}` `{detail}`. */
  traceRanCommand: string;
  /** … a command the user refused or that expired unanswered. */
  traceWantedCommand: string;
  traceToolDetail: string;
  /** Authorization outcome appended to the phrase: `{option}` = chosen option label. */
  traceApprovalNote: string;
  traceApprovalDenied: string;
  traceApprovalExpired: string;
  /** More than two actions: `{count}` = total. */
  traceSummaryMore: string;
  /**
   * Runner step names by step key (`claimed`, `auth`, `launch`, `session`,
   * `sent`, `operation`, `terminal`); `<key>:running` while in progress.
   * Missing keys keep the runner's own name (e.g. 「Claude 原生会话已就绪」).
   */
  stageLabels: Record<string, string>;
  /** User message accepted by Daisy, not yet confirmed by the Agent. */
  userStatusSent: string;
  /** Tool authorization card: plain line for a shell command (`{command}`). */
  approvalCommand: string;
  /** … toggles for the raw request parameters under that line. */
  approvalShowInput: string;
  approvalHideInput: string;
  /** Agent login card (DaisyAgentLogin) heading and explanation. */
  loginTitle: string;
  loginBody: string;
  /** Agent login card when no usable execution node exists. */
  loginNoNode: string;
  /** Login job waiting for the runner to pick it up. */
  loginQueued: string;
  /** Conversation line while a turn is queued. */
  queuedNotice: string;
  /** Composer status line while a turn is queued (shared edits serialize; enforced readers may run together). */
  queuedStatus: string;
  /** Composer status line while the Agent works. */
  runningStatus: string;
  /** Send preview note about attachments; `{count}` = number of files. */
  attachmentsNote: string;
  /** Times and dates: BCP 47 locale (branding `lang`); undefined = browser. */
  locale?: string;
  /** 12-hour clock; undefined = 24-hour for Chinese locales, else locale default. */
  hour12?: boolean;
}
/**
 * P6-22 (ADR-159): the copy's text fields, each the language pack's
 * `ui-copy.<field>` (a fixed set, so read with `t.dynamic`). A field's
 * `{placeholders}` stay for the reader to fill (`fillCopy`).
 */
const COPY_TEXT_FIELDS = [
  "approvalBadge",
  "approvalWaiting",
  "approvalWaitingHint",
  "approvalOpenInbox",
  "approvalRecords",
  "approvalRelaxNote",
  "approvalAllowed",
  "approvalDenied",
  "approvalExpired",
  "composerPlaceholder",
  "emptyTitle",
  "emptyBody",
  "taskBanner",
  "footer",
  "loadErrorNotFound",
  "loadErrorForbidden",
  "loadErrorUnauthorized",
  "loadErrorUnavailable",
  "reconnecting",
  "previewTitle",
  "previewSame",
  "traceStart",
  "contextAttach",
  "contextAttached",
  "contextAttachedHint",
  "contextSkipped",
  "contextRestore",
  "contextDismiss",
  "contextShow",
  "contextHide",
  "contextCommandHint",
  "contextTag",
  "contextShowAll",
  "contextSwitched",
  "contextTrimmed",
  "contextInvalid",
  "userStatusQueued",
  "userStatusAccepted",
  "userStatusError",
  "userStatusCancelled",
  "userStatusRequeued",
  "userStatusAppended",
  "userStatusHanded",
  "userStatusRead",
  "messageRetracted",
  "jumpSubagentsWarning",
  "jumpAfterTurn",
  "jumpAnyway",
  "connectingStatus",
  "sendingStatus",
  "idleStatus",
  "resumableStatus",
  "loadingStatus",
  "syncingStatus",
  "offlineContent",
  "aiOnlining",
  "deviceOffline",
  "deviceOfflineQueued",
  "runningNotice",
  "traceTitle",
  "traceProgress",
  "traceActive",
  "traceInterrupted",
  "traceExpand",
  "traceCollapse",
  "traceSummaryTools",
  "traceSummarySteps",
  "traceSummaryRunning",
  "traceWorking",
  "traceRanCommand",
  "traceWantedCommand",
  "traceToolDetail",
  "traceApprovalNote",
  "traceApprovalDenied",
  "traceApprovalExpired",
  "traceSummaryMore",
  "userStatusSent",
  "approvalCommand",
  "approvalShowInput",
  "approvalHideInput",
  "loginTitle",
  "loginBody",
  "loginNoNode",
  "loginQueued",
  "queuedNotice",
  "queuedStatus",
  "runningStatus",
  "attachmentsNote",
] as const satisfies readonly (keyof DaisyCopy)[];
const STATUS_LABELS = [
  "idle",
  "completed",
  "queued",
  "running",
  "waiting",
  "interrupted",
  "error",
] as const;
/** `{command}` is a built-in message param (the command's name): keep it a placeholder here. */
const KEEP = { command: "{command}" };
const agentLabels = () => ({
  claude: "Claude Code",
  codex: "Codex",
  // P4-10: every ACP harness's name (Kimi Code CLI, OpenCode …).
  ...Object.fromEntries(ACP_AGENTS.map((a) => [a, agentName(a)])),
});

/** The default copy in `t`'s language (hosts' overrides are merged over it). */
export function defaultDaisyCopyFor(t: Translate): DaisyCopy {
  const text = Object.fromEntries(
    COPY_TEXT_FIELDS.map((f) => [f, t.dynamic(`ui-copy.${f}`, KEEP)]),
  ) as Record<(typeof COPY_TEXT_FIELDS)[number], string>;
  return {
    ...text,
    labels: {
      ...agentLabels(),
      ...Object.fromEntries(
        STATUS_LABELS.map((k) => [k, t.dynamic(`ui-copy.labels.${k}`)]),
      ),
    },
    commandDescriptions: {},
    stageLabels: {},
    productName: PRODUCT_NAME,
  };
}

/**
 * Wording preset for hosts where "审批/approval" means something else (e.g. a
 * human decision): Daisy's approvals are presented as 工具授权 (tool
 * authorization), and status labels use one short set.
 */
export function toolAuthorizationCopyFor(t: Translate): Partial<DaisyCopy> {
  const preset = Object.fromEntries(
    TOOL_AUTH_FIELDS.map((f) => [f, t.dynamic(`ui-copy.toolAuth.${f}`)]),
  ) as Partial<DaisyCopy>;
  return {
    ...preset,
    labels: Object.fromEntries(
      STATUS_LABELS.map((k) => [k, t.dynamic(`ui-copy.toolAuth.labels.${k}`)]),
    ),
    commandDescriptions: {
      permissions: t("ui-copy.toolAuth.commandDescriptions.permissions"),
    },
  };
}
const TOOL_AUTH_FIELDS = [
  "approvalBadge",
  "approvalWaiting",
  "approvalWaitingHint",
  "approvalOpenInbox",
  "approvalRecords",
  "approvalRelaxNote",
  "approvalAllowed",
  "approvalDenied",
  "approvalExpired",
] as const satisfies readonly (keyof DaisyCopy)[];

/** An object whose fields read `make()` (the current language) on every access. */
function live<T extends object>(make: () => T): T {
  const out = {} as T;
  for (const k of Object.keys(make()))
    Object.defineProperty(out, k, {
      enumerable: true,
      get: () => (make() as any)[k],
    });
  return out;
}
/**
 * The default copy in the UI's current language (fields read the language
 * on access; spreading it takes the text of that moment). Kept for
 * compatibility — components use `useDaisyCopy()`.
 */
export const defaultDaisyCopy: DaisyCopy = live(() => defaultDaisyCopyFor(tr));
/**
 * The tool-authorization preset in the UI's current language (live
 * fields, like `defaultDaisyCopy`): pass it as `copy` and the wording
 * follows a language switch.
 */
export const toolAuthorizationCopy: Partial<DaisyCopy> = live(() =>
  toolAuthorizationCopyFor(tr),
);


/** Lifecycle phase of the conversation, for host status chips. */
export type DaisyChatPhase =
  | "idle"
  | "queued"
  | "running"
  | "awaiting-authorization"
  | "completed"
  | "failed"
  | "interrupted";
export interface DaisyChatStatus {
  sessionId: string;
  phase: DaisyChatPhase;
  /** Raw Daisy session status. */
  status: Session["status"];
  /** Pending tool-authorization requests. */
  pendingAuthorizations: number;
  session: Session;
}

interface HostValue {
  adapters: DaisyHostAdapters;
  /**
   * The hosts' copy overrides, outermost first. They are merged over the
   * default copy where it is read (`useDaisyCopy`), so the defaults — and a
   * preset with live fields (`toolAuthorizationCopy`) — follow a language
   * switch.
   */
  patches: readonly Partial<DaisyCopy>[];
}
const HostContext = createContext<HostValue>({
  adapters: {},
  patches: [],
});
export function mergeCopy(
  base: DaisyCopy,
  patch?: Partial<DaisyCopy>,
): DaisyCopy {
  return patch
    ? {
        ...base,
        ...patch,
        labels: { ...base.labels, ...patch.labels },
        commandDescriptions: {
          ...base.commandDescriptions,
          ...patch.commandDescriptions,
        },
        stageLabels: { ...base.stageLabels, ...patch.stageLabels },
      }
    : base;
}
/** Copy label key for a lifecycle phase (`copy.labels[key]`). */
export const phaseLabelKey: Record<DaisyChatPhase, string> = {
  idle: "idle",
  completed: "completed",
  queued: "queued",
  running: "running",
  "awaiting-authorization": "waiting",
  failed: "error",
  interrupted: "interrupted",
};
/**
 * Phase of a session from its list entry alone (no transcript): an idle
 * session whose first turn was delivered counts as completed.
 */
export function daisySessionPhase(session: Session): DaisyChatPhase {
  switch (session.status) {
    case "waiting":
      return "awaiting-authorization";
    case "queued":
    case "running":
    case "interrupted":
      return session.status;
    case "error":
      return "failed";
    default:
      return (session.contextDelivered ?? !!session.nativeId)
        ? "completed"
        : "idle";
  }
}
/**
 * Host integration context: platform adapters and copy overrides. Nested
 * providers merge with their parent. Keep the objects stable.
 */
export function DaisyHostProvider({
  adapters,
  copy,
  children,
}: {
  adapters?: DaisyHostAdapters;
  copy?: Partial<DaisyCopy>;
  children: React.ReactNode;
}) {
  const parent = useContext(HostContext);
  const value = useMemo(
    () =>
      adapters || copy
        ? {
            adapters: { ...parent.adapters, ...adapters },
            patches: copy ? [...parent.patches, copy] : parent.patches,
          }
        : parent,
    [parent, adapters, copy],
  );
  return <HostContext.Provider value={value}>{children}</HostContext.Provider>;
}
/** The copy in effect: the default in the UI's language with the hosts' overrides. */
function useCopy(patches: readonly Partial<DaisyCopy>[]): DaisyCopy {
  const t = useT();
  return useMemo(
    () => patches.reduce<DaisyCopy>(mergeCopy, defaultDaisyCopyFor(t)),
    [t, patches],
  );
}
export function useDaisyHost() {
  const { adapters, patches } = useContext(HostContext);
  const copy = useCopy(patches);
  return useMemo(() => ({ adapters, copy }), [adapters, copy]);
}
export function useDaisyCopy() {
  return useCopy(useContext(HostContext).patches);
}
/** Open an external URL through the host adapter, falling back to Linking. */
export function useOpenUrl() {
  const { openUrl } = useContext(HostContext).adapters;
  return useCallback(
    async (url: string) => {
      await (openUrl ? openUrl(url) : Linking.openURL(url));
    },
    [openUrl],
  );
}
/** Time / date formatters following `copy.locale` and `copy.hour12`. */
export function useDaisyTime() {
  const { locale, hour12 } = useDaisyCopy();
  // P6-22: no host locale → the UI's language.
  const lang = useT().lang;
  return useMemo(
    () => daisyTimeFormat({ locale: locale ?? lang, hour12 }),
    [locale, lang, hour12],
  );
}
const hostOriginsCache = new Map<string, Promise<string[]>>();
/**
 * DAISY_ORIGINS as served by the public /api/health (`hostOrigins`): the
 * other origins a host link may point to. Fetched once per server.
 */
export function useHostOrigins(client: DaisyClient) {
  const [origins, setOrigins] = useState<string[]>([]);
  useEffect(() => {
    let live = true;
    let pending = hostOriginsCache.get(client.baseUrl);
    if (!pending) {
      pending = client
        .health()
        .then((h) => h.hostOrigins ?? [])
        .catch(() => {
          hostOriginsCache.delete(client.baseUrl);
          return [];
        });
      hostOriginsCache.set(client.baseUrl, pending);
    }
    void pending.then((o) => live && setOrigins(o));
    return () => {
      live = false;
    };
  }, [client]);
  return origins;
}
