import { useReadingWidth } from "./reading-width";
import { t as tr, useT } from "./i18n";
import { Text } from "./primitives";
import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  View,
  ScrollView,
  TextInput,
  Pressable,
  Image,
  Platform,
  KeyboardAvoidingView,
  useWindowDimensions,
} from "react-native";
import { ActivityTrack, Pulse, Reveal } from "./activity";
import { ContextGaugeButton } from "./context-gauge";
import {
  CompactNotice,
  LiveBadge,
  ModelChip,
  TraceDots,
  WakeMarker,
  useTicker,
} from "./tracebar";
import { NativeTerminal } from "./terminal";
import { CommandPalette, CommandCenter } from "./commands";
import {
  agentLabel,
  approvalCategory,
  buildPrompt,
  commandList,
  commandOffered,
  COMMAND_FEATURES,
  unsupportedMessage,
  fitMessageContext,
  residentVisible,
  residentHeld,
  schedulerPendingOf,
  shownName,
  type AgentCommand,
  type MessageContext,
  type MessageContextInput,
} from "@daisy-ai/contracts";
import Markdown from "./markdown";
import { ComposerResizeBar } from "./composer-resize";
import { useComposerHeight } from "./composer-size";
import type {
  Snapshot,
  Item,
  Attachment,
  Approval,
  TerminalResult,
} from "@daisy-ai/contracts";
import {
  DaisyClient,
  DaisyError,
  makeId,
  type SessionWatch,
} from "@daisy-ai/client";
import { Button, Badge, ErrorBox } from "./primitives";
import {
  DaisyHostProvider,
  useDaisyCopy,
  useDaisyHost,
  useDaisyTime,
  useHostOrigins,
  useOpenUrl,
  phaseLabelKey,
  type DaisyChatPhase,
  type DaisyChatStatus,
  type DaisyCopy,
  type DaisyHostAdapters,
  type DaisyPickedFile,
} from "./host";
import { defaultPickFiles, defaultSaveFile } from "./platform";
import { QueueRowText, type QueueRowItem } from "./queue-row";
import {
  busyComposerHint,
  canSteer,
  jumpConfirmed,
  jumpNotice,
  keyboardDevice,
  bulkRemoveNotice,
  mergeJumpNotice,
  mergeSteerNotice,
  nextTurnLabel,
  queueBulk,
  queueRemoveLabel,
  queueRowLabel,
  queueRowSelectable,
  rememberJumpConfirmed,
  waitingQueue,
} from "./queue-jump";
import {
  contextPlan,
  gateAfterSend,
  gateAfterSnapshot,
  gateOnContextKey,
  initialContextGate,
  type ContextGate,
} from "./context";
import { pickedBase64 } from "./files";
import { dragHasFiles, droppedFiles, pastedImages } from "./paste-files";
import { SessionDropZone } from "./chat-drop-zone";
import {
  cachedAt,
  cachedSnapshot,
  inflightSnapshot,
  rememberSnapshot,
  SESSION_TAIL,
} from "./session-cache";
import {
  EARLIER_STEP,
  earlierStep,
  keepPosition,
  nearTop,
  readAhead,
} from "./history-window";
import {
  ageText,
  aiPresence,
  freshnessReducer,
  initialFreshness,
  viewFreshness,
  useDelayed,
  useFreshness,
  useTicking,
  type Freshness,
} from "./freshness";
import {
  getDraft,
  runInFlight,
  setDraft,
  subscribeDraft,
  watchRun,
  type ChatDraft,
} from "./drafts";
import { REWIND_WORDS, canRewindFiles, editBannerText } from "./rewind-copy";
import {
  agoText,
  backgroundCount,
  commandOf,
  fillCopy,
  groupTurns,
  turnEnd,
  originHeading,
  currentTurnIndex,
  safeHostHref,
  stepLine,
  userStatusText,
} from "./present";
import {
  DaisyThemeProvider,
  daisyPhaseColor,
  useDaisyFocusScope,
  useDaisyTheme,
  withAlpha,
  type DaisyTheme,
  type DaisyThemeInput,
} from "./theme";
function AttachmentView({
  a,
  client,
}: {
  a: Attachment;
  client: DaisyClient;
}) {
  const [uri, setUri] = useState(""),
    [error, setError] = useState("");
  const { C, rad } = useDaisyTheme();
  const { adapters } = useDaisyHost();
  useEffect(() => {
    let closed = false,
      url = "";
    if (a.mime.startsWith("image/")) {
      if (Platform.OS === "web") {
        void client
          .attachment(a)
          .then((b) => {
            url = URL.createObjectURL(b);
            if (!closed) setUri(url);
            else URL.revokeObjectURL(url);
          })
          .catch(() => setError(tr("ui-chat.image.readFailed")));
      } else setUri(`${client.baseUrl}/api/attachments/${a.id}`);
    }
    return () => {
      closed = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [a.id, client]);
  const download = async () => {
    try {
      const request = {
        kind: "attachment" as const,
        name: a.name,
        mimeType: a.mime,
        attachment: a,
        read: () => client.attachment(a),
      };
      await (adapters.saveFile
        ? adapters.saveFile(request)
        : defaultSaveFile(request, client));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <View style={{ marginTop: 9, gap: 6 }}>
      {uri ? (
        <Image
          accessibilityLabel={a.name}
          source={
            Platform.OS === "web"
              ? { uri }
              : client.token
                ? { uri, headers: { Authorization: `Bearer ${client.token}` } }
                : { uri }
          }
          style={{
            width: 280,
            maxWidth: "100%",
            height: 190,
            borderRadius: rad(10),
            backgroundColor: C.bg,
          }}
          resizeMode="contain"
        />
      ) : null}
      <Pressable onPress={() => void download()} accessibilityRole="button">
        <Text style={{ color: C.accent, fontSize: 12 }}>
          ↗ {a.name} · {Math.max(1, Math.round(a.size / 1024))} KB
        </Text>
      </Pressable>
      <ErrorBox text={error} />
    </View>
  );
}
/** Danger palette of 「在终端执行」 mode: the same in every theme. */
/** the subagent warning is for 「合并插队」, not one card. */
const MERGE_WARN = "__merge__";
const TERMINAL = {
  field: "#3d0b0e",
  line: "#b42318",
  ink: "#fde8e8",
  faint: "#e7a1a1",
};
const exitText = (
  r: Pick<TerminalResult, "exitCode" | "timedOut" | "error">,
) =>
  r.error
    ? tr("ui-chat.terminal.exitNotRun")
    : r.timedOut
      ? tr("ui-chat.terminal.exitTimedOut")
      : r.exitCode === null
        ? tr("ui-chat.terminal.exitUnfinished")
        : r.exitCode === 0
          ? "✓ 0"
          : `✗ ${r.exitCode}`;
/** Command + output of one terminal run, monospace, scrolls when long. */
function TerminalOutput({ r }: { r: TerminalResult }) {
  const { C, s, rad, sp } = useDaisyTheme();
  const t = useT();
  return (
    <View
      style={{
        backgroundColor: C.bg,
        borderRadius: rad(8),
        padding: sp(10),
        gap: 4,
      }}
    >
      <Text selectable style={[s.mono, { fontWeight: "700" }]}>
        $ {r.command}
      </Text>
      <Text style={{ fontSize: 10, color: C.faint }}>
        {t("ui-chat.terminal.runLine", {
          cwd: r.cwd,
          exit: exitText(r),
          seconds: (r.durationMs / 1000).toFixed(1),
        })}
        {r.truncated ? t("ui-chat.terminal.truncatedNote") : ""}
      </Text>
      <ScrollView style={{ maxHeight: 220 }}>
        <Text selectable style={s.mono}>
          {r.error || r.output || t("ui-chat.terminal.noOutput")}
        </Text>
      </ScrollView>
    </View>
  );
}
/** Terminal runs sent with a user message: one line each, tap to expand. */
function TerminalResults({ runs }: { runs: TerminalResult[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const { C, s } = useDaisyTheme();
  const t = useT();
  return (
    <View style={{ marginTop: 8, gap: 6 }} testID="message-terminal">
      {runs.map((r) => (
        <View key={r.id} style={{ gap: 6 }}>
          <Pressable
            accessibilityRole="button"
            onPress={() => setOpen(open === r.id ? null : r.id)}
          >
            <Text numberOfLines={1} style={[s.mono, { color: C.muted }]}>
              {open === r.id ? "▾" : "▸"}{" "}
              {t("ui-chat.terminal.resultLine", {
                cmd: r.command,
                exit: exitText(r),
              })}
            </Text>
          </Pressable>
          {open === r.id ? <TerminalOutput r={r} /> : null}
        </View>
      ))}
    </View>
  );
}
/**
 * How full the Agent's context is: a ring with the percentage,
 * from the latest `<jid>:context` usage item. Web draws SVG; elsewhere text.
 */
/**
 * The trace bar's small line: step number, what the Agent does now
 * and for how long; when idle, when the last turn ended. Ticks on its own so
 * the conversation does not re-render every second.
 */
function TraceDetail({
  fixed,
  busy,
  activity,
  streaming,
  endedAt,
  pending,
}: {
  fixed: string | null;
  busy: boolean;
  activity: Item[];
  streaming: boolean;
  endedAt: number;
  pending: number;
}) {
  const { C } = useDaisyTheme();
  const t = useT();
  const now = useTicker(fixed === null, busy ? 1000 : 30_000);
  const text =
    fixed ??
    (busy
      ? stepLine(activity, now, { streaming })
      : t("ui-chat.trace.idle", {
          ago: agoText(now - endedAt),
          background: pending
            ? t("ui-chat.trace.idleBackground", { count: pending })
            : "",
        }));
  return (
    <Text
      testID="trace-detail"
      numberOfLines={1}
      style={{ fontSize: 11, color: C.faint }}
    >
      {text}
    </Text>
  );
}
/**
 * A question another Agent / person asked this Agent, or
 * the answer to this Agent's own question. It is a
 * user-role turn for the model, but not the owner's words: shown as a card
 * from the sender, the full prompt only on request.
 */
function PeerMessage({
  item,
}: {
  item: Item & { origin: NonNullable<Item["origin"]> };
}) {
  const { C, s, rad, sp } = useDaisyTheme();
  const when = useDaisyTime();
  const t = useT();
  const [full, setFull] = useState(false);
  const o = item.origin;
  const who =
    o.senderKind === "agent"
      ? t("ui-chat.peer.agentQuoted", {
          label: agentLabel({ title: o.senderName, ownerName: o.ownerName }, t),
        })
      : o.senderName;
  // a Daisy event (classifier retry) is no failure.
  const { heading, failure, event } = originHeading(o, who);
  return (
    <Reveal style={{ marginVertical: 14 }}>
      <View
        testID={event ? "daisy-event" : `peer-${o.type}`}
        style={{
          borderWidth: 1,
          borderColor: failure ? C.red : C.line,
          borderLeftWidth: 3,
          borderLeftColor: failure ? C.red : event ? C.muted : C.accent,
          backgroundColor: C.surfaceAlt,
          borderRadius: rad(12),
          padding: sp(14),
          gap: sp(8),
        }}
      >
        <View style={[s.row, { flexWrap: "wrap" }]}>
          <Text style={{ fontSize: 12, fontWeight: "700", color: C.ink }}>
            {heading}
          </Text>
          {o.place && !event ? (
            <Text style={{ fontSize: 11, color: C.muted }}>· {o.place}</Text>
          ) : null}
          <Text style={{ color: C.faint, fontSize: 10 }}>
            {when.time(item.createdAt)}
          </Text>
        </View>
        {o.question ? <Markdown>{o.question}</Markdown> : null}
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: full }}
          onPress={() => setFull((x) => !x)}
        >
          <Text style={{ fontSize: 11, color: C.accent }}>
            {full ? t("ui-chat.peer.hidePrompt") : t("ui-chat.peer.showPrompt")}
          </Text>
        </Pressable>
        {full ? (
          <Text selectable style={[s.mono, { fontSize: 11, color: C.muted }]}>
            {item.text}
          </Text>
        ) : null}
      </View>
    </Reveal>
  );
}
/**
 * One transcript message; re-renders only when its item changed (a new
 * snapshot keeps the objects of unchanged items, see `keepItems`).
 */
const Message = React.memo(
  function Message(props: Parameters<typeof PlainMessage>[0]) {
    return props.item.origin ? (
      <PeerMessage item={props.item as any} />
    ) : (
      <PlainMessage {...props} />
    );
  },
  (a, b) =>
    a.item === b.item &&
    a.client === b.client &&
    a.agent === b.agent &&
    a.waiting === b.waiting &&
    !a.onEdit === !b.onEdit,
);
/**
 * A fresh snapshot over the shown one: items equal to shown ones keep their
 * object, so unchanged messages are not rendered again (the newest few
 * hundred are compared; older ones are not on screen).
 */
function keepItems(shown: Snapshot | null, next: Snapshot): Snapshot {
  if (!shown || shown.session.id !== next.session.id) return next;
  const old = new Map<string, Item>();
  for (const it of shown.items.slice(-400)) old.set(it.id, it);
  let changed = false;
  const items = next.items.map((it, i) => {
    if (i < next.items.length - 400) return it;
    const o = old.get(it.id);
    if (o && o !== it && JSON.stringify(o) === JSON.stringify(it)) {
      changed = true;
      return o;
    }
    return it;
  });
  return changed ? { ...next, items } : next;
}
function PlainMessage({
  item,
  client,
  agent,
  waiting = false,
  onEdit,
}: {
  item: Item;
  client: DaisyClient;
  agent: string;
  /** A queued (排队) message still waiting for the current turn to end. */
  waiting?: boolean;
  /** Edit and resend this user message; absent = not editable now. */
  onEdit?: () => void;
}) {
  const user = item.kind === "user";
  const { C, s, rad, sp, agents: colors } = useDaisyTheme();
  const copy = useDaisyCopy(),
    { labels } = copy;
  const when = useDaisyTime();
  const t = useT();
  return (
    <Reveal
      style={{ marginVertical: 14, alignItems: user ? "flex-end" : "stretch" }}
    >
      <View
        style={[
          s.row,
          { marginBottom: 9, justifyContent: user ? "flex-end" : "flex-start" },
        ]}
      >
        {!user ? (
          <View
            style={{
              width: 24,
              height: 24,
              borderRadius: rad(7),
              backgroundColor: withAlpha(colors[agent] || C.accent, "18"),
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Text
              style={{
                fontSize: 12,
                fontWeight: "700",
                color: colors[agent] || C.accent,
              }}
            >
              {agent === "claude" ? "✳" : agent === "codex" ? "◈" : "K"}
            </Text>
          </View>
        ) : null}
        <Text style={{ fontSize: 11, fontWeight: "600", color: C.muted }}>
          {user
            ? t("ui-chat.message.you")
            : item.kind === "notice"
              ? t("ui-chat.message.notice")
              : labels[agent]}
        </Text>
        {user && item.status ? (
          <Text
            style={{
              fontSize: 10,
              color: item.status === "error" ? C.red : C.muted,
            }}
          >
            {userStatusText(item, copy, waiting)}
          </Text>
        ) : null}
        {item.retracted ? (
          <Text
            testID="message-retracted"
            style={{ fontSize: 10, color: C.muted }}
          >
            {copy.messageRetracted}
          </Text>
        ) : null}
        <Text style={{ color: C.faint, fontSize: 10 }}>
          {when.time(item.createdAt)}
        </Text>
        {onEdit ? (
          <Pressable
            testID="edit-message"
            accessibilityRole="button"
            accessibilityLabel={t("ui-chat.message.editA11y")}
            onPress={onEdit}
          >
            <Text style={{ color: C.accent, fontSize: 11 }}>
              {t("ui-chat.message.edit")}
            </Text>
          </Pressable>
        ) : null}
      </View>
      <View
        style={[
          user
            ? {
                backgroundColor: C.userBubble,
                paddingHorizontal: sp(18),
                paddingVertical: sp(9),
                borderRadius: rad(14),
                maxWidth: "92%",
              }
            : item.kind === "notice"
              ? {
                  backgroundColor: C.bg,
                  padding: sp(12),
                  borderRadius: rad(10),
                }
              : undefined,
          // Retracted: kept, greyed — not the answer.
          item.retracted ? { opacity: 0.45 } : undefined,
        ]}
      >
        <Markdown>{item.text}</Markdown>
        {item.attachments?.map((a) => (
          <AttachmentView key={a.id} a={a} client={client} />
        ))}
        {item.terminal?.length ? (
          <TerminalResults runs={item.terminal} />
        ) : null}
      </View>
      {user && item.context ? <ContextTag context={item.context} /> : null}
    </Reveal>
  );
}
/**
 * A page-context change this soon after mounting is the host settling its
 * context (e.g. a route key refined once the page loads), not the user
 * switching pages: no 「已切换到」 highlight (review r2 N4).
 */
const SWITCH_SETTLE_MS = 1500;
/** `{label}` placeholder of the context copy strings. */
const withLabel = (template: string, label: string) =>
  template.replace(/\{label\}/g, label);
/**
 * Host page context text, under the composer bar or a message tag. It never
 * scrolls by itself (review G10): long text shows its first `lines` lines
 * and 「展开全部」.
 */
function ContextText({
  context,
  lines = 8,
}: {
  context: MessageContext;
  /** Lines shown before 「展开全部」. */
  lines?: number;
}) {
  const [all, setAll] = useState(false);
  const { C, s, rad, sp } = useDaisyTheme();
  const copy = useDaisyCopy();
  const long =
    context.text.length > lines * 50 || context.text.split("\n").length > lines;
  return (
    <View
      style={{
        backgroundColor: C.surfaceAlt,
        borderRadius: rad(8),
        padding: sp(10),
        gap: 4,
      }}
    >
      {context.url ? (
        <Text selectable numberOfLines={1} style={[s.muted, { fontSize: 11 }]}>
          {context.url}
        </Text>
      ) : null}
      <Text
        testID="context-text"
        selectable
        numberOfLines={all || !long ? undefined : lines}
        style={s.mono}
      >
        {context.text}
      </Text>
      {long ? (
        <Pressable
          testID="context-text-all"
          accessibilityRole="button"
          accessibilityState={{ expanded: all }}
          onPress={() => setAll(!all)}
        >
          <Text style={{ fontSize: 11, color: C.accent }}>
            {all ? copy.contextHide : copy.contextShowAll}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}
/** Small 「上下文：{label}」 tag under a user message that carried a context. */
function ContextTag({ context }: { context: MessageContext }) {
  const [open, setOpen] = useState(false);
  const { C } = useDaisyTheme();
  const copy = useDaisyCopy();
  const t = useT();
  const tag = withLabel(copy.contextTag, context.label);
  return (
    <View
      testID="message-context"
      // Shrinks to the label but never wider than the bubble column; the
      // label ellipsizes instead of overflowing to the left (review S2).
      style={{
        marginTop: 4,
        alignSelf: "flex-end",
        maxWidth: "92%",
        width: open ? "92%" : undefined,
        alignItems: "flex-end",
        gap: 4,
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={t("ui-chat.context.tagA11y", {
          tag,
          action: open ? copy.contextHide : copy.contextShow,
        })}
        onPress={() => setOpen(!open)}
        style={{ maxWidth: "100%", flexDirection: "row" }}
      >
        <Text
          numberOfLines={1}
          ellipsizeMode="tail"
          style={{ fontSize: 11, color: C.faint, flexShrink: 1 }}
        >
          ◎ {tag}
        </Text>
        <Text
          style={{ fontSize: 11, color: C.faint, flexShrink: 0, marginLeft: 4 }}
        >
          {open ? "▾" : "▸"}
        </Text>
      </Pressable>
      {open ? (
        <View style={{ alignSelf: "stretch" }}>
          <ContextText context={context} />
        </View>
      ) : null}
    </View>
  );
}
/**
 * Bar above the composer: which host page context the next message carries
 * (fb3 F2). `attached` = this session already carries the same key, so it
 * is not sent again; `skipped` = the user closed it for the next message;
 * `switched` = the page context just changed (brief highlight, review S3).
 */
function ContextBar({
  context,
  attached,
  skipped,
  command,
  switched,
  trimmed,
  open,
  lines,
  onToggle,
  onSkip,
  onRestore,
}: {
  context: MessageContext;
  attached: boolean;
  skipped: boolean;
  command: boolean;
  switched: boolean;
  trimmed: boolean;
  open: boolean;
  lines: number;
  onToggle: () => void;
  onSkip: () => void;
  onRestore: () => void;
}) {
  const { C, s, rad, sp } = useDaisyTheme();
  const copy = useDaisyCopy();
  const live = !attached && !skipped;
  return (
    <View testID="context-bar" style={{ gap: 6 }}>
      <View
        testID={switched ? "context-bar-switched" : undefined}
        style={[
          s.row,
          {
            gap: 8,
            paddingHorizontal: sp(10),
            paddingVertical: sp(6),
            borderRadius: rad(10),
            borderWidth: 1,
            borderColor: switched
              ? C.accent
              : live
                ? withAlpha(C.accent, "55")
                : C.line,
            backgroundColor: switched
              ? withAlpha(C.accent, "26")
              : live
                ? withAlpha(C.accent, "12")
                : C.surfaceAlt,
          },
        ]}
      >
        <Text
          style={{ fontSize: 12, color: live || switched ? C.accent : C.faint }}
        >
          ◎
        </Text>
        <Text
          testID="context-bar-label"
          numberOfLines={1}
          accessibilityLiveRegion="polite"
          style={{
            flex: 1,
            fontSize: 12,
            color: switched ? C.ink : skipped ? C.faint : C.muted,
            fontWeight: switched ? "600" : "400",
          }}
        >
          {withLabel(
            switched
              ? copy.contextSwitched
              : skipped
                ? copy.contextSkipped
                : copy.contextAttach,
            context.label,
          )}
        </Text>
        {attached && !skipped ? (
          <Badge text={copy.contextAttached} color={C.green} />
        ) : null}
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          onPress={onToggle}
        >
          <Text style={{ fontSize: 11, color: C.accent }}>
            {open ? copy.contextHide : copy.contextShow}
          </Text>
        </Pressable>
        {skipped ? (
          <Pressable
            testID="context-restore"
            accessibilityRole="button"
            onPress={onRestore}
          >
            <Text style={{ fontSize: 11, color: C.accent }}>
              {copy.contextRestore}
            </Text>
          </Pressable>
        ) : !attached ? (
          <Pressable
            testID="context-dismiss"
            accessibilityRole="button"
            accessibilityLabel={copy.contextDismiss}
            onPress={onSkip}
            hitSlop={8}
          >
            <Text style={{ fontSize: 14, lineHeight: 16, color: C.muted }}>
              ×
            </Text>
          </Pressable>
        ) : null}
      </View>
      {live && command ? (
        <Text style={{ fontSize: 11, color: C.faint, paddingHorizontal: 4 }}>
          {copy.contextCommandHint}
        </Text>
      ) : null}
      {open ? (
        <View testID="context-panel" style={{ gap: 4 }}>
          {attached && !skipped ? (
            <Text style={{ fontSize: 11, color: C.faint }}>
              {copy.contextAttachedHint}
            </Text>
          ) : null}
          {trimmed ? (
            <Text style={{ fontSize: 11, color: C.faint }}>
              {copy.contextTrimmed}
            </Text>
          ) : null}
          <ContextText context={context} lines={lines} />
        </View>
      ) : null}
    </View>
  );
}
export function ApprovalCard({
  approval: a,
  client,
  sid,
  onError,
  onStale,
}: {
  approval: Approval;
  client: DaisyClient;
  sid: string;
  onError: (s: string) => void;
  /** The approval was already answered / expired (409): refresh the view. */
  onStale?: () => void;
}) {
  const [busy, setBusy] = useState(false),
    // Answered here (or found already answered): hide at once instead of
    // waiting for the live update, so a second click can't hit a 409.
    [gone, setGone] = useState(false),
    [answers, setAnswers] = useState<Record<string, string>>({});
  const { C, s, rad, sp } = useDaisyTheme();
  const copy = useDaisyCopy(),
    openUrl = useOpenUrl();
  const t = useT();
  const input = a.input as any;
  const questions = input?.questions || [];
  // A shell command reads as one plain line; the raw request stays one tap
  // away (review r2 N6).
  const command = commandOf(input);
  const [showInput, setShowInput] = useState(!command);
  // D-39: a harness permission prompt is answered right
  // here or on the 「审批」 page, whichever first — the card decides it
  // through the inbox's own route (owner only), so both stay one decision.
  const permission = approvalCategory(a) === "permission";
  const { adapters } = useDaisyHost();
  if (gone) return null;
  return (
    <View
      testID="approval-card"
      style={{
        borderWidth: 1,
        borderColor: C.orangeLine,
        borderRadius: rad(12),
        backgroundColor: C.orangeSoft,
        padding: sp(16),
        gap: sp(12),
        marginVertical: 12,
      }}
    >
      <View style={s.row}>
        <Text style={{ fontSize: 17, color: C.orange }}>◇</Text>
        <Text
          style={{ fontSize: 14, fontWeight: "600", color: C.ink, flex: 1 }}
        >
          {a.title}
        </Text>
        <Badge text={copy.approvalBadge} color={C.orange} />
      </View>
      {permission && a.reason ? (
        <Text testID="approval-reason" selectable style={s.muted}>
          {a.reason}
        </Text>
      ) : null}
      {command ? (
        <View style={{ gap: 6 }}>
          <Text testID="approval-command" selectable style={{ color: C.ink }}>
            {fillCopy(copy.approvalCommand, { command })}
          </Text>
          <Pressable
            testID="approval-input-toggle"
            accessibilityRole="button"
            accessibilityState={{ expanded: showInput }}
            onPress={() => setShowInput(!showInput)}
            style={{ alignSelf: "flex-start" }}
          >
            <Text style={{ fontSize: 11, color: C.accent }}>
              {showInput ? copy.approvalHideInput : copy.approvalShowInput}
            </Text>
          </Pressable>
        </View>
      ) : null}
      {showInput ? (
        <ScrollView style={{ maxHeight: 220 }} nestedScrollEnabled>
          <Text selectable style={s.mono}>
            {typeof input === "string" ? input : JSON.stringify(input, null, 2)}
          </Text>
        </ScrollView>
      ) : null}
      {input?.mode === "url" && /^https:\/\//i.test(input.url || "") ? (
        <Button
          variant="soft"
          onPress={() =>
            void openUrl(input.url).catch((e) => onError(e.message))
          }
        >
          {t("ui-chat.approval.openMcp")}
        </Button>
      ) : null}
      {questions.map((q: any, i: number) => {
        const key = q.id || q.question || String(i);
        return (
          <View key={key} style={{ gap: 8 }}>
            <Text style={s.muted}>{q.question || q.header || q.title}</Text>
            <View style={[s.row, { flexWrap: "wrap" }]}>
              {q.options?.map((o: any) => (
                <Button
                  variant={answers[key] === (o.label || o) ? "primary" : "soft"}
                  key={o.label || o}
                  onPress={() =>
                    setAnswers({
                      ...answers,
                      [key]: q.multiSelect
                        ? (answers[key] || "")
                            .split(", ")
                            .filter(Boolean)
                            .includes(o.label || o)
                          ? (answers[key] || "")
                              .split(", ")
                              .filter((x) => x !== (o.label || o))
                              .join(", ")
                          : [
                              ...(answers[key] || "")
                                .split(", ")
                                .filter(Boolean),
                              o.label || o,
                            ].join(", ")
                        : o.label || o,
                    })
                  }
                >
                  {o.label || o}
                </Button>
              ))}
            </View>
            <TextInput
              accessibilityLabel={q.question || q.title || t("ui-chat.approval.answer")}
              secureTextEntry={!!q.isSecret}
              style={s.input}
              value={answers[key] || ""}
              onChangeText={(v) => setAnswers({ ...answers, [key]: v })}
              placeholder={t("ui-chat.approval.answerPlaceholder")}
            />
          </View>
        );
      })}
      <View style={[s.row, { flexWrap: "wrap" }]}>
        {a.options.map((o, i) => (
          <Button
            key={o.id}
            variant={
              /deny|decline|reject|cancel/i.test(o.id)
                ? "ghost"
                : i === 0
                  ? "primary"
                  : "soft"
            }
            busy={busy}
            onPress={() => {
              if (busy) return;
              setBusy(true);
              void (
                permission
                  ? client.respondApproval("perm:" + a.id, o.id)
                  : client.approve(
                      sid,
                      a.id,
                      o.id,
                      Object.keys(answers).length ? answers : undefined,
                    )
              )
                .then(() => setGone(true))
                .catch((e) => {
                  // Already answered elsewhere (another tab, the session
                  // page) or expired: not the user's error — just refresh
                  // (the host UI feedback 2026-10-11).
                  if (e instanceof DaisyError && e.status === 409) {
                    setGone(true);
                    onStale?.();
                  } else onError(e.message);
                })
                .finally(() => setBusy(false));
            }}
          >
            {o.label}
          </Button>
        ))}
      </View>
      {permission && adapters?.openApprovals ? (
        <Pressable
          testID="approval-open-inbox"
          accessibilityRole="link"
          onPress={() => adapters.openApprovals?.()}
          style={{ alignSelf: "flex-start" }}
        >
          <Text style={{ fontSize: 11, color: C.accent }}>
            {copy.approvalOpenInbox || t("ui-copy.approvalOpenInbox")}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}
/** One-line summary of what a tool request touches (command, file, URL). */
function requestSummary(input: any): string {
  const v =
    typeof input === "string"
      ? input
      : (input?.command ??
        input?.cmd ??
        input?.file_path ??
        input?.path ??
        input?.url ??
        input?.pattern ??
        "");
  const line = (Array.isArray(v) ? v.join(" ") : String(v))
    .replace(/\s+/g, " ")
    .trim();
  return line.length > 80 ? line.slice(0, 79) + "…" : line;
}
/**
 * Collapsed record of an answered / expired tool authorization, kept in the
 * conversation: 「已授权 Bash: pwd（允许本次）」. Tap to see the request.
 */
function ApprovalRecord({ approval: a }: { approval: Approval }) {
  const [open, setOpen] = useState(false);
  const { C, s, rad, sp } = useDaisyTheme();
  const copy = useDaisyCopy();
  const option = a.options.find((o) => o.id === a.decision?.optionId);
  const denied =
    a.status === "answered" &&
    /deny|decline|reject|cancel|abort/i.test(a.decision?.optionId || "");
  const verb =
    a.status === "expired"
      ? copy.approvalExpired
      : denied
        ? copy.approvalDenied
        : copy.approvalAllowed;
  const summary = requestSummary(a.input);
  return (
    <View testID="approval-record" style={{ marginVertical: 4 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(!open)}
        style={[s.row, { gap: 6, paddingVertical: 4 }]}
      >
        <Text
          style={{
            fontSize: 12,
            color: a.status === "expired" ? C.faint : denied ? C.red : C.accent,
          }}
        >
          {a.status === "expired" ? "○" : denied ? "✕" : "✓"}
        </Text>
        <Text
          numberOfLines={1}
          style={{ fontSize: 12, color: C.muted, flex: 1 }}
        >
          {verb} {a.title}
          {summary ? `: ${summary}` : ""}
          {option
            ? fillCopy(copy.traceApprovalNote, { option: option.label })
            : ""}
        </Text>
        <Text style={{ fontSize: 11, color: C.faint }}>{open ? "▾" : "▸"}</Text>
      </Pressable>
      {open ? (
        <View
          style={{
            backgroundColor: C.surfaceAlt,
            borderRadius: rad(8),
            padding: sp(10),
          }}
        >
          <Text selectable style={s.mono}>
            {typeof a.input === "string"
              ? a.input
              : JSON.stringify(a.input, null, 2)}
          </Text>
        </View>
      ) : null}
    </View>
  );
}
/**
 * what the conversation shows vs the server, and where its AI is,
 * over the top of the transcript. Fresh: an empty marker (data-freshness).
 */
function FreshnessBar({
  kind,
  sessionId,
  text,
  presence,
  presenceText,
}: {
  kind: string;
  sessionId: string;
  text: string;
  presence: string | null;
  presenceText: string;
}) {
  const { C, rad } = useDaisyTheme();
  const pills: { key: string; text: string; color: string; pulse: boolean }[] =
    [];
  if (text)
    pills.push({
      key: "fresh",
      text,
      color: kind === "offline" ? C.orange : C.muted,
      pulse: kind !== "offline",
    });
  if (presenceText)
    pills.push({
      key: "presence",
      text: presenceText,
      color: presence === "device-offline" ? C.orange : C.accent,
      pulse: presence === "onlining",
    });
  return (
    <View
      testID="chat-freshness"
      // @ts-expect-error dataSet is react-native-web's data-* attributes.
      dataSet={{ freshness: kind, freshnessOf: sessionId }}
      accessibilityLiveRegion="polite"
      pointerEvents="none"
      style={{
        position: "absolute",
        zIndex: 5,
        top: 8,
        left: 0,
        right: 0,
        alignItems: "center",
        gap: 6,
      }}
    >
      {pills.map((p) => (
        <View
          key={p.key}
          testID={`chat-freshness-${p.key}`}
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 6,
            paddingHorizontal: 10,
            paddingVertical: 4,
            borderRadius: rad(999),
            backgroundColor: C.paper,
            borderWidth: 1,
            borderColor: C.line,
            shadowColor: "#000",
            shadowOpacity: 0.06,
            shadowRadius: 6,
            shadowOffset: { width: 0, height: 2 },
          }}
        >
          {p.pulse ? (
            <Pulse color={p.color} />
          ) : (
            <View
              style={{
                width: 6,
                height: 6,
                borderRadius: 3,
                backgroundColor: p.color,
              }}
            />
          )}
          <Text style={{ fontSize: 11.5, color: p.color }}>{p.text}</Text>
        </View>
      ))}
    </View>
  );
}
/** Nothing to show yet: the transcript's shape, and 「正在加载对话…」 after 150 ms. */
function TranscriptSkeleton({ hint }: { hint: string }) {
  const { C, rad } = useDaisyTheme();
  const t = useT();
  return (
    <View
      testID="chat-loading"
      accessibilityRole="progressbar"
      accessibilityLabel={hint || t("ui-chat.loading")}
      aria-busy
      style={{
        flex: 1,
        justifyContent: "flex-end",
        gap: 14,
        paddingBottom: 24,
      }}
    >
      {[0.55, 0.8, 0.4, 0.7].map((w, i) => (
        <View
          key={i}
          style={{
            alignSelf: i % 2 ? "flex-start" : "flex-end",
            width: `${w * 100}%`,
            height: i % 2 ? 54 : 22,
            borderRadius: rad(10),
            backgroundColor: C.soft,
            opacity: 0.7,
          }}
        />
      ))}
      <Text
        style={{
          alignSelf: "center",
          marginTop: 8,
          fontSize: 12,
          color: C.muted,
          opacity: hint ? 1 : 0,
        }}
      >
        {hint || " "}
      </Text>
    </View>
  );
}
export interface DaisyChatProps {
  client: DaisyClient;
  sessionId: string;
  /** /new, /resume, /fork switched the conversation to another session. */
  onNavigate?: (id: string) => void;
  /** Every fresh session snapshot (title, status, task…). */
  onSessionChange?: (s: Snapshot["session"]) => void;
  /**
   * Lifecycle changes only (phase or pending tool-authorization count), for a
   * host status chip: running / awaiting-authorization / completed / failed…
   */
  onStatusChange?: (status: DaisyChatStatus) => void;
  headerActions?: React.ReactNode;
  /** Theme for this conversation; merged over any enclosing DaisyThemeProvider. */
  theme?: DaisyThemeInput | DaisyTheme;
  /** Platform hooks (file picker, save/share, links, terminal); merged over DaisyHostProvider. */
  adapters?: DaisyHostAdapters;
  /** Wording overrides, e.g. `toolAuthorizationCopy`; merged over DaisyHostProvider. */
  copy?: Partial<DaisyCopy>;
  /**
   * `full` (default): conversation header (title, agent, connection, status,
   * / 命令) and task banner. `compact`: both hidden for hosts that already
   * show the title and task; status, / 命令 and `headerActions` move into one
   * small toolbar line above the composer.
   */
  chrome?: "full" | "compact";
  /**
   * The conversation could not be loaded: 404 (missing), 403 (someone
   * else's), 401, or network / 5xx before any snapshot arrived. DaisyChat
   * shows a plain error state with the composer disabled, keeps retrying, and
   * reports each new error kind once (cleared when a snapshot arrives).
   */
  onLoadError?: (error: DaisyChatLoadError) => void;
  /**
   * The host page the user is on (fb3 F1). The next message carries it —
   * shown in a bar above the composer, closable for one message — unless
   * this session's latest user message with a context has the same `key`
   * (already attached: not sent again, F2). `/` commands never carry it.
   */
  context?: MessageContext | MessageContextInput | null;
  /** A message carrying `context` was accepted by Daisy (normalized context). */
  onContextSent?: (context: MessageContext) => void;
  /**
   * Focus the composer once it first becomes usable (snapshot loaded), e.g.
   * right after the host created the conversation. Once per session ID.
   */
  autoFocus?: boolean;
  /**
   * Kept-alive views (chat latency work, round 2): a host that keeps this
   * conversation rendered while hidden passes whether it is shown. Hidden,
   * it holds its last snapshot and opens no connection and no polling;
   * shown again, it reconnects without re-rendering what it shows.
   */
  activity?: DaisyChatActivity;
}
/** Shown / hidden signal of a kept-alive DaisyChat (read, never rendered). */
export interface DaisyChatActivity {
  get(): boolean;
  subscribe(fn: () => void): () => void;
}
/** Run `start` while `activity` says shown (always without one). */
function whileActive(
  activity: DaisyChatActivity | undefined,
  start: () => () => void,
) {
  let stop: (() => void) | null = null,
    pending: any = null;
  const sync = () => {
    const on = !activity || activity.get();
    if (on && !stop && !pending) {
      // Shown again: reconnect once that frame is painted (the snapshot it
      // brings must not delay the frame that shows the conversation).
      if (!activity) stop = start();
      else
        pending = setTimeout(() => {
          pending = null;
          if (activity.get() && !stop) stop = start();
        }, 16);
    } else if (!on) {
      clearTimeout(pending);
      pending = null;
      if (stop) {
        stop();
        stop = null;
      }
    }
  };
  sync();
  const unsubscribe = activity?.subscribe(sync);
  return () => {
    unsubscribe?.();
    clearTimeout(pending);
    stop?.();
  };
}
/** Why DaisyChat could not show the conversation (see `onLoadError`). */
export interface DaisyChatLoadError {
  /** HTTP status; undefined for network failures. */
  status?: number;
  /** Server error code, when it sent one (e.g. `unauthenticated`). */
  code?: string;
  /** Server / network message (for logs; DaisyChat shows `copy.loadError*`). */
  message: string;
}
/** Map a snapshot to the host-facing lifecycle phase. */
export function daisyChatPhase(snap: Snapshot): DaisyChatPhase {
  const pending = snap.approvals.some((a) => a.status === "pending");
  switch (snap.session.status) {
    case "waiting":
      return "awaiting-authorization";
    case "queued":
      return "queued";
    case "running":
      return pending ? "awaiting-authorization" : "running";
    case "error":
      return "failed";
    case "interrupted":
      return "interrupted";
    default:
      return snap.items.some((i) => i.kind === "user") ? "completed" : "idle";
  }
}
/** Turns a conversation opens with; the next ones follow after that paint. */
const FIRST_TURNS = 6;
/** Freshness of a conversation opened from the page's cache (unconfirmed). */
function freshnessFromCache(client: DaisyClient, sid: string): Freshness {
  const cached = cachedSnapshot(client, sid);
  return cached
    ? freshnessReducer(initialFreshness, {
        type: "cache",
        version: cached.cursor,
        at: cachedAt(client, sid),
      })
    : initialFreshness;
}
/** Drop-in conversation surface. Host owns authentication/navigation and passes a scoped session ID. */
/**
 * after 「换身份」 the transcript could not be carried (the turn
 * failed with the reason). Besides switching back, the owner may give the
 * native history up — two presses, the second one confirms.
 */
function IdentityFresh({
  client,
  sid,
  onError,
  onDone,
}: {
  client: DaisyClient;
  sid: string;
  onError: (message: string) => void;
  onDone: () => void;
}) {
  const { C, s, rad, sp } = useDaisyTheme();
  const t = useT();
  const [confirming, setConfirming] = useState(false),
    [busy, setBusy] = useState(false);
  const go = async () => {
    if (!confirming) return setConfirming(true);
    setBusy(true);
    onError("");
    try {
      await client.request(`/sessions/${sid}/identity/fresh`, "POST", {});
      setConfirming(false);
      onDone();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <View
      testID="identity-fresh"
      style={{
        borderWidth: 1,
        borderColor: C.line,
        borderRadius: rad(10),
        padding: sp(10),
        gap: 8,
      }}
    >
      <Text style={s.muted}>
        {confirming
          ? t("ui-chat.identityFresh.confirmNote")
          : t("ui-chat.identityFresh.note")}
      </Text>
      <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
        <Button
          testID="identity-fresh-button"
          busy={busy}
          variant={confirming ? "primary" : "soft"}
          onPress={() => void go()}
        >
          {confirming
            ? t("ui-chat.identityFresh.confirm")
            : t("ui-chat.identityFresh.go")}
        </Button>
        {confirming ? (
          <Button variant="soft" onPress={() => setConfirming(false)}>
            {t("ui-chat.cancel")}
          </Button>
        ) : null}
      </View>
    </View>
  );
}
export function DaisyChat({
  theme,
  adapters,
  copy,
  ...props
}: DaisyChatProps) {
  let view = <ChatView {...props} />;
  if (adapters || copy)
    view = (
      <DaisyHostProvider adapters={adapters} copy={copy}>
        {view}
      </DaisyHostProvider>
    );
  return theme ? (
    <DaisyThemeProvider value={theme}>{view}</DaisyThemeProvider>
  ) : (
    view
  );
}
function ChatView({
  client,
  sessionId: initialSessionId,
  onNavigate,
  onSessionChange,
  onStatusChange,
  onLoadError,
  onContextSent,
  context: rawContext,
  autoFocus = false,
  headerActions,
  chrome = "full",
  activity,
}: Omit<DaisyChatProps, "theme" | "adapters" | "copy">) {
  const reading = useReadingWidth("daisy.chat.width");
  const [sessionId, setSessionId] = useState(initialSessionId);
  useEffect(() => setSessionId(initialSessionId), [initialSessionId]);
  const navigate = (id: string) => {
    setSessionId(id);
    onNavigate?.(id);
  };
  const [traceOpen, setTraceOpen] = useState(false);
  /** a resident's full run log (hidden by default). */
  const [showLog, setShowLog] = useState(false);
  const [panel, setPanel] = useState<string | null>(null),
    [slashIndex, setSlashIndex] = useState(0),
    [slashDismissed, setSlashDismissed] = useState(false),
    [queued, setQueued] = useState<
      {
        id: string;
        text: string;
        jump?: boolean;
        from?: string;
        jumpBlocked?: string;
        runningSubagents?: number;
        merged?: number;
        steerable?: boolean;
        /** 「合并追加」 can append it natively. */
        appendable?: boolean;
        steerIn?: boolean;
        nextTurn?: boolean;
        nextTurnWhy?: string;
        nextTurnWait?: string;
        carriedItems?: QueueRowItem["carriedItems"];
        /** in the running turn's native queue, not read yet. */
        appended?: boolean;
        appendState?: string;
        appendLabel?: string;
        appendAuto?: boolean;
      }[]
    >([]),
    // queued rows ticked for 「合并插队」 / 「合并追加」.
    [picked, setPicked] = useState<Record<string, boolean>>({}),
    // Queued rows opened to their full text (tap the text again to fold).
    [opened, setOpened] = useState<Record<string, boolean>>({}),
    [merging, setMerging] = useState<string>(""),
    // 「插队发送」 would stop running subagents — asked first.
    [jumpWarn, setJumpWarn] = useState<{ jid: string; count: number } | null>(
      null,
    ),
    // R #7: 「插队发送」 in flight / what it answered, by queued job id.
    [jumping, setJumping] = useState<Record<string, string>>({}),
    // Review M3: ⌘/Ctrl+Enter asks once before it stops a turn.
    [confirmJump, setConfirmJump] = useState(false),
    [nativeTerminal, setNativeTerminal] = useState(false);
  // fb3 F2 (see ./context): 「不附带」 for one message, and the context just
  // accepted by Daisy until the snapshot shows its item.
  // User items of messages queued behind the running turn (「等待发送」).
  const pendingItems = useRef(new Set<string>());
  /**
   * queued messages removed here — not started, even before the
   * control plane's 「已取消」 item arrives (else the trace bar briefly
   * pointed at the removed message's empty turn: 「正在准备…」).
   */
  const removedItems = useRef(new Set<string>());
  const composer = useRef<TextInput>(null),
    autoFocused = useRef(false);
  const [gate, setGate] = useState<ContextGate>(initialContextGate),
    [contextOpen, setContextOpen] = useState(false),
    [contextSwitched, setContextSwitched] = useState(false);
  // Reopened / prefetched conversations paint from the last snapshot at
  // once (./session-cache); watch() then brings the current one.
  const [snap, setSnap] = useState<Snapshot | null>(() =>
      cachedSnapshot(client, initialSessionId),
    ),
    [loadError, setLoadError] = useState<DaisyChatLoadError | null>(null),
    [connection, setConnection] = useState("reconnecting"),
    // what the view shows vs the server (separate from fetching).
    [fresh, dispatchFresh] = useFreshness(() =>
      freshnessFromCache(client, initialSessionId),
    ),
    [loadingOlder, setLoadingOlder] = useState(false),
    [error, setError] = useState(""),
    [sending, setSending] = useState(false),
    [preview, setPreview] = useState(false),
    [focused, setFocused] = useState(false),
    [uploading, setUploading] = useState(false),
    [stick, setStick] = useState(true);
  // The composer lives in ./drafts, per conversation: leaving the
  // chat (host route, drawer view, another conversation) and coming back
  // finds the text, attachments, terminal runs and an edit where they were.
  // 「在终端执行」: stays on until turned off; finished runs wait
  // above the composer and go out with the next message to the Agent.
  // Edit and resend: `editing` is the user message being rewritten.
  const { text, attachments, runs, terminalMode, editing } =
    useSyncExternalStore(
      useCallback(
        (fn: () => void) => subscribeDraft(sessionId, fn),
        [sessionId],
      ),
      () => getDraft(sessionId),
    );
  // The box grew over the end of the conversation (typing, or the drag bar
  // — on the Web without a render): the reader at the end stays there.
  const pinEnd = useCallback(() => {
    if ((!activity || activity.get()) && stickRef.current)
      scroll.current?.scrollToEnd({ animated: false });
  }, [activity]);
  const composerSize = useComposerHeight(composer, text, pinEnd);
  useLayoutEffect(pinEnd, [pinEnd, composerSize.height]);
  const draftField =
    <K extends keyof ChatDraft>(key: K) =>
    (v: ChatDraft[K] | ((prev: ChatDraft[K]) => ChatDraft[K])) =>
      setDraft(sessionId, (d) => ({
        [key]:
          typeof v === "function"
            ? (v as (prev: ChatDraft[K]) => ChatDraft[K])(d[key])
            : v,
      }));
  const setText = draftField("text"),
    setAttachments = draftField("attachments"),
    setRuns = draftField("runs"),
    setTerminalMode = draftField("terminalMode"),
    setEditing = draftField("editing");
  const [openRun, setOpenRun] = useState<string | null>(null);
  // 「同时撤销文件」 for this edit (off by default, per edit).
  const [rewindFiles, setRewindFiles] = useState(false);
  useEffect(() => setRewindFiles(false), [editing?.id]);
  const scroll = useRef<React.ElementRef<typeof ScrollView>>(null),
    request = useRef<string | null>(null),
    { width } = useWindowDimensions();
  const { C, s, rad, sp, font } = useDaisyTheme();
  const { adapters, copy } = useDaisyHost(),
    labels = copy.labels;
  const t = useT();
  // Callbacks are read through a ref so a host passing inline functions never
  // resubscribes the live connection.
  const callbacks = useRef({
    onSessionChange,
    onStatusChange,
    onLoadError,
    onContextSent,
  });
  callbacks.current = {
    onSessionChange,
    onStatusChange,
    onLoadError,
    onContextSent,
  };
  const focusScope = useDaisyFocusScope() as any;
  const lastStatus = useRef("");
  useEffect(() => {
    if (!snap || snap.session.id !== sessionId) return;
    const phase = daisyChatPhase(snap),
      pendingAuthorizations = snap.approvals.filter(
        (a) => a.status === "pending",
      ).length,
      key = `${sessionId}:${phase}:${pendingAuthorizations}`;
    if (key === lastStatus.current) return;
    lastStatus.current = key;
    callbacks.current.onStatusChange?.({
      sessionId,
      phase,
      status: snap.session.status,
      pendingAuthorizations,
      session: snap.session,
    });
  }, [snap, sessionId]);
  /** Turns rendered, newest last: long transcripts open with the end. */
  const [turnLimit, setTurnLimit] = useState(FIRST_TURNS);
  const mountedSession = useRef(sessionId);
  useEffect(() => {
    setSnap(cachedSnapshot(client, sessionId));
    if (mountedSession.current !== sessionId) {
      mountedSession.current = sessionId;
      dispatchFresh({ type: "reset" });
      const cached = cachedSnapshot(client, sessionId);
      if (cached)
        dispatchFresh({
          type: "cache",
          version: cached.cursor,
          at: cachedAt(client, sessionId),
        });
    }
    setTurnLimit(FIRST_TURNS);
    // A conversation opens at its end.
    stickRef.current = true;
    lastOffset.current = 0;
    anchor.current = null;
    setStick(true);
    setLoadError(null);
    setError("");
    setOpenRun(null);
    setGate(initialContextGate);
    setContextOpen(false);
    pendingItems.current = new Set();
    removedItems.current = new Set();
    autoFocused.current = false;
    request.current = null;
  }, [client, sessionId]);
  const snapRef = useRef(snap);
  snapRef.current = snap;
  // Shown again: still at the end if it was (before that frame paints).
  const stickRef = useRef(true),
    lastOffset = useRef(0),
    contentHeight = useRef(0),
    /** A reading position to keep while turns are added above. */
    anchor = useRef<{
      fromBottom: number;
      until: number;
      applied: boolean;
    } | null>(null);
  useEffect(
    () =>
      activity?.subscribe(() => {
        if (activity.get() && stickRef.current)
          scroll.current?.scrollToEnd({ animated: false });
      }),
    [activity],
  );
  // the live socket says when the server has a newer version
  // (`announce`); fetching asks only for what changed since the held cursor.
  const watchRef = useRef<SessionWatch | null>(null);
  useEffect(() => {
    let loaded = false,
      reported = "";
    return whileActive(activity, () => {
      let w: SessionWatch | null = null,
        stopped = false;
      const begin = () => {
        if (stopped) return;
        const shown = snapRef.current;
        w = client.watchSession(
          sessionId,
          {
            data: (s, { at, reset }) => {
              loaded = true;
              reported = "";
              setLoadError(null);
              rememberSnapshot(client, s, at, reset);
              dispatchFresh({ type: "data", version: s.cursor, at, reset });
              // The view it already shows (kept alive / cached): nothing to
              // render again.
              const shown = snapRef.current;
              if (
                !shown ||
                shown.session.id !== s.session.id ||
                shown.cursor !== s.cursor ||
                shown.items.length !== s.items.length ||
                !shown.partial !== !s.partial ||
                JSON.stringify(shown.session) !== JSON.stringify(s.session) ||
                JSON.stringify(shown.node) !== JSON.stringify(s.node) ||
                shown.rewindFiles !== s.rewindFiles ||
                // P4-11: a Runner that updated its CLI declares anew.
                JSON.stringify(shown.features) !== JSON.stringify(s.features)
              )
                setSnap(keepItems(shown, s));
              callbacks.current.onSessionChange?.(s.session);
            },
            version: (version) => dispatchFresh({ type: "announce", version }),
            connection: setConnection,
            error: (e) => {
              const status = e instanceof DaisyError ? e.status : undefined;
              // Missing / foreign / signed-out conversations are terminal for
              // this view; network trouble only counts until a first snapshot
              // exists (afterwards the view says 离线 with the content's age).
              const fatal = status === 401 || status === 403 || status === 404;
              if (fatal) dispatchFresh({ type: "reset" });
              dispatchFresh({ type: "fail", error: e.message });
              if (!fatal && loaded) return;
              if (fatal) setSnap(null);
              const next: DaisyChatLoadError = {
                ...(status !== undefined ? { status } : {}),
                ...(e instanceof DaisyError && e.code ? { code: e.code } : {}),
                message: e.message,
              };
              setLoadError(next);
              const key = `${next.status ?? "net"}:${next.code ?? ""}`;
              if (key !== reported) {
                reported = key;
                callbacks.current.onLoadError?.(next);
              }
            },
          },
          {
            initial:
              shown?.session.id === sessionId
                ? shown
                : cachedSnapshot(client, sessionId),
            tail: SESSION_TAIL,
          },
        );
        watchRef.current = w;
      };
      // Opened while its prefetch (hover / intent) is still in flight: wait
      // for that answer and go on from it, instead of asking twice.
      const pending =
        !snapRef.current && !cachedSnapshot(client, sessionId)
          ? inflightSnapshot(client, sessionId)
          : undefined;
      if (pending)
        void pending.then(() => {
          if (stopped) return;
          const cached = cachedSnapshot(client, sessionId);
          if (cached && !snapRef.current) {
            snapRef.current = cached;
            setSnap(cached);
            dispatchFresh({
              type: "cache",
              version: cached.cursor,
              at: cachedAt(client, sessionId),
            });
          }
          begin();
        });
      else begin();
      return () => {
        stopped = true;
        w?.close();
        if (watchRef.current === w) watchRef.current = null;
        // Hidden: no longer listening, what it holds is unconfirmed again.
        dispatchFresh({ type: "suspend" });
      };
    });
  }, [client, sessionId, activity]);
  // Runs still going when the chat was left (or the tab reloaded).
  useEffect(() => {
    for (const r of getDraft(sessionId).runs)
      if (runInFlight(r)) watchRun(client, sessionId, r.id);
  }, [client, sessionId]);
  const loadActivity = useCallback(
    () => client.liveActivity(sessionId),
    [client, sessionId],
  );
  const busy =
    !!snap && ["queued", "running", "waiting"].includes(snap.session.status);
  const compact = chrome === "compact";
  // compact (review r2 S4): the phase badge carries running / waiting /
  // failed; the line only speaks for connection trouble and sending, and is
  // empty when idle (just / 命令).
  const phase = snap ? daisyChatPhase(snap) : null;
  // Wrapped so the badge centres in its row (Badge itself is flex-start).
  const phaseBadge = phase ? (
    <View testID="chat-phase" style={{ alignSelf: "center" }}>
      <Badge
        text={labels[phaseLabelKey[phase]] || phase}
        color={daisyPhaseColor(C, phase)}
      />
    </View>
  ) : null;
  const loadErrorText = loadError
    ? loadError.status === 404
      ? copy.loadErrorNotFound
      : loadError.status === 403
        ? copy.loadErrorForbidden
        : loadError.status === 401
          ? copy.loadErrorUnauthorized
          : copy.loadErrorUnavailable.replace(
              /\{productName\}/g,
              copy.productName,
            )
    : "";
  const blocked = !snap || !!loadError;
  // P1-01: residents are off until stage 4 (no route creates one); the
  // resident branches of this view stay for stage 4's rebuild.
  // A paused resident takes no messages — the
  // composer says so and offers 恢复运行 (the server answers 409 anyway).
  const residentPaused =
    !!snap &&
    snap.session.kind === "resident" &&
    !snap.session.archived &&
    residentHeld(snap.session);
  useEffect(() => {
    if (!autoFocus || blocked || autoFocused.current) return;
    autoFocused.current = true;
    // After the editable prop has been applied to the DOM.
    const timer = setTimeout(() => composer.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, [autoFocus, blocked, sessionId]);
  // 404 / 403 / 401 are final for this view; network trouble and 5xx (e.g. a
  // gateway 502 while Daisy restarts) are retried, and every surface says
  // the same thing: copy.reconnecting.
  const fatalLoad =
    !!loadError &&
    (loadError.status === 401 ||
      loadError.status === 403 ||
      loadError.status === 404);
  const offline = connection === "offline" || (!!loadError && !fatalLoad);
  const statusText = !compact || fatalLoad || offline || !snap || sending;
  // never show kept content as if it were current, never a blank
  // pane without a word. 「正在同步…」 while a kept / announced-older view
  // is brought up to date; 「离线，显示的是 N 分钟前的内容」 while the server
  // can't be reached; 「正在加载对话…」 after 150 ms with nothing to show.
  const freshKind = viewFreshness(fresh, connection);
  const now = useTicking(freshKind === "offline", 10_000);
  const loadingLate = useDelayed(!snap && !loadError, 150);
  // Brought up to date within 150 ms: no hint flashes (as for loading).
  const syncingLate = useDelayed(
    freshKind === "cached" || freshKind === "stale",
    150,
  );
  const freshText =
    syncingLate && (freshKind === "cached" || freshKind === "stale")
      ? copy.syncingStatus
      : freshKind === "offline" && snap && fresh.held
        ? copy.offlineContent.replace("{age}", ageText(fresh.held.at, now))
        : "";
  // Where its AI is: 「所在设备离线」 / 「AI 正在上线…」.
  const presence = aiPresence(snap);
  const presenceText =
    presence === "device-offline"
      ? (busy ? copy.deviceOfflineQueued : copy.deviceOffline).replace(
          "{label}",
          snap?.node ? shownName("node", snap.node, t) : t("ui-chat.status.node"),
        )
      : presence === "onlining"
        ? copy.aiOnlining
        : "";
  const connectionText = fatalLoad
    ? t("ui-chat.status.cannotOpen")
    : !snap && !loadError
      ? loadingLate
        ? copy.loadingStatus
        : ""
      : freshText ||
        (offline
          ? copy.reconnecting
          : connection === "live"
            ? t("ui-chat.status.live")
            : copy.reconnecting);
  // Task banner link: host adapter first; otherwise task.url (host mode: top
  // window, same-origin / DAISY_ORIGINS only; standalone: like any link).
  const hostOrigins = useHostOrigins(client);
  const openUrl = useOpenUrl();
  const task = snap?.session.task;
  // Host mode = gateway auth (empty token): the link replaces the top window,
  // so only same-origin / DAISY_ORIGINS targets. Standalone: any http(s),
  // opened like a Markdown link.
  const hostMode = client.token === "" && Platform.OS === "web";
  const taskHref = !task?.url
    ? null
    : hostMode
      ? safeHostHref(task.url, window.location.href, hostOrigins)
      : /^https?:\/\/[^\s\\]+$/i.test(task.url)
        ? task.url
        : null;
  const openTask =
    task && adapters.openTask
      ? () => adapters.openTask!(task, sessionId)
      : taskHref
        ? () => {
            if (hostMode) window.open(taskHref, "_top");
            else void openUrl(taskHref);
          }
        : null;
  // P4-11 (C-3): only what the session's AI declares.
  const commands = commandList(
    snap?.session.agent || "claude",
    snap?.session.commandCatalog?.commands,
    snap?.features,
    t,
  );
  const query = /^\/([^\s]*)$/.exec(text)?.[1];
  const slashOpen = !terminalMode && query !== undefined && !slashDismissed;
  const matches = commands.filter(
    (c) => c.name.includes(query || "") || c.title.includes(query || ""),
  );
  const chooseCommand = (c: AgentCommand) => {
    setSlashDismissed(true);
    if (c.kind === "prompt") {
      setText((snap?.session.agent === "codex" ? "$" : "/") + c.name + " ");
      return;
    }
    setText("");
    setPanel(c.name);
  };
  // The queue: read on open and when the turn starts / ends; polled only
  // while a turn runs or messages wait (no idle polling).
  const queueLive = busy || queued.length > 0;
  // A new message / wake in the conversation: read the queue now,
  // so a cron wake or someone else's request queued behind the running turn is known
  // as queued before the trace bar would point at it.
  const heads = useMemo(
    () =>
      (snap?.items || []).filter(
        (i) => i.id.startsWith("user:") || i.id.startsWith("wake:"),
      ).length,
    [snap],
  );
  useEffect(
    () =>
      whileActive(activity, () => {
        let closed = false;
        const refresh = () =>
          void client
            .queue(sessionId)
            .then((q) => {
              if (!closed)
                setQueued((prev) => {
                  // rows the agent has read are not queue rows.
                  const w = waitingQueue(q);
                  return JSON.stringify(prev) === JSON.stringify(w) ? prev : w;
                });
            })
            .catch(() => {});
        refresh();
        const timer = queueLive ? setInterval(refresh, 2000) : null;
        return () => {
          closed = true;
          if (timer) clearInterval(timer);
        };
      }),
    [client, sessionId, activity, queueLive, busy, heads],
  );
  // Host context made to fit the schema (cut / hashed key, review G1), so a
  // long page never turns every send into a 400; null + invalid when unusable.
  const fitted = useMemo(() => fitMessageContext(rawContext), [rawContext]);
  const context = fitted.context;
  useEffect(() => {
    if (snap) setGate((g) => gateAfterSnapshot(g, snap.items));
  }, [snap]);
  // A new page context: drop a 「不附带」 meant for the old one, collapse the
  // text panel and briefly highlight the bar (review S3).
  // Only a real change counts (review r2 N4): from one key to a different
  // key within this mount, not the first key, not null → key, and not the
  // host settling its page context right after mounting.
  const previousKey = useRef<string | null>(null);
  const mountedAt = useRef(Date.now());
  useEffect(() => {
    const key = context?.key ?? null;
    setGate((g) => gateOnContextKey(g, key));
    setContextOpen(false);
    const previous = previousKey.current;
    previousKey.current = key;
    if (!key || !previous || previous === key) {
      setContextSwitched(false);
      return;
    }
    if (Date.now() - mountedAt.current < SWITCH_SETTLE_MS) return;
    setContextSwitched(true);
    const timer = setTimeout(() => setContextSwitched(false), 2500);
    return () => clearTimeout(timer);
  }, [context?.key]);
  const plan = contextPlan(
    context,
    snap?.items || [],
    gate,
    text,
    snap?.contextKey,
  );
  const finished = runs.filter(
    (r) => r.status === "complete" || r.status === "error",
  );
  // The last turn (from its user message or Agent wake marker): what the
  // trace bar describes and its expanded view shows.
  // Item ids of jobs still queued behind the running turn: the owner's
  // messages, others' requests, Daisy wakes (「等待发送」).
  const waitingHead = useMemo(() => {
    const ids = new Set(
      queued.flatMap((q) => [`user:${q.id}`, `wake:${q.id}`]),
    );
    return (id: string) =>
      pendingItems.current.has(id) ||
      removedItems.current.has(id) ||
      ids.has(id);
  }, [queued]);
  const groupedTurns = useMemo(
    () => groupTurns(snap?.items || [], waitingHead),
    [snap, waitingHead],
  );
  const firstTurn = Math.max(0, groupedTurns.length - turnLimit);
  // Older turns: those held first; a window cut from a long conversation
  // pages the rest in from the server, only when asked.
  // Reading upward: within a screen of the top, more turns show by
  // themselves — held ones first, then an older page from the server (read
  // ahead in the background) — and what is being read stays where it is.
  // The button does the same by hand.
  const earlierBusy = useRef(false);
  const holdPosition = (fromBottom: number) => {
    anchor.current = { fromBottom, until: Date.now() + 1500, applied: false };
  };
  const loadEarlier = async (fromBottom?: number) => {
    if (earlierBusy.current) return;
    const partial = !!snap?.partial;
    const step = earlierStep(firstTurn, partial);
    if (!step || (step === "fetch" && !watchRef.current)) return;
    earlierBusy.current = true;
    holdPosition(fromBottom ?? contentHeight.current - lastOffset.current);
    try {
      if (step === "fetch") {
        setLoadingOlder(true);
        await watchRef.current!.older(300);
      }
      holdPosition(contentHeight.current - lastOffset.current);
      setTurnLimit((n) => n + EARLIER_STEP);
      if (step === "show" && readAhead(firstTurn, partial))
        void watchRef.current
          ?.older(300)
          // Before the page renders: it may grow the first shown turn.
          .then(() => holdPosition(contentHeight.current - lastOffset.current))
          .catch(() => {});
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoadingOlder(false);
      earlierBusy.current = false;
    }
  };
  // After the first paint of a conversation, more turns follow.
  useEffect(() => {
    if (!snap || turnLimit !== FIRST_TURNS) return;
    const frame = requestAnimationFrame(() =>
      setTimeout(() => setTurnLimit((n) => (n === FIRST_TURNS ? 40 : n)), 0),
    );
    return () => cancelAnimationFrame(frame);
  }, [snap, turnLimit]);
  // The running turn, not a queued message's / wake's turn behind it.
  const liveTurn = useMemo(
    () => currentTurnIndex(groupedTurns, waitingHead),
    [groupedTurns, waitingHead],
  );
  const lastTurn = useMemo(() => {
    const turn = groupedTurns[liveTurn] || [];
    const from = turn[0]?.createdAt ?? 0;
    return {
      activity: turn.filter((x) => x.kind === "tool" || x.kind === "thinking"),
      streaming: turn.some(
        (x) => x.kind === "assistant" && x.status === "streaming",
      ),
      endedAt: Math.max(0, ...turn.map((x) => x.createdAt)),
      decided: (snap?.approvals || []).filter(
        (a) => a.status !== "pending" && a.createdAt >= from,
      ),
    };
  }, [groupedTurns, liveTurn, snap]);
  const pendingApproval = snap?.approvals.find((a) => a.status === "pending");
  const live = snap?.session.live;
  // Fixed wording, or null: the step / idle line (timed, see TraceDetail).
  const traceFixed = fatalLoad
    ? t("ui-chat.unavailable")
    : offline
      ? freshText || copy.reconnecting
      : !snap
        ? copy.loadingStatus
        : sending
          ? copy.sendingStatus
          : presenceText
            ? presenceText
            : snap.session.status === "queued"
              ? copy.queuedStatus
              : snap.session.status === "waiting"
                ? pendingApproval
                  ? // D-39: answerable right here (or on the 「审批」 page).
                    t("ui-chat.status.awaitingApproval", {
                      title: pendingApproval.title,
                    })
                  : copy.approvalWaitingHint
                : !busy && !snap.items.length
                  ? snap.session.nativeId
                    ? copy.resumableStatus
                    : copy.idleStatus
                  : null;
  const runCommand = async () => {
    const command = text.trim();
    if (blocked || !command) return;
    setSending(true);
    setError("");
    try {
      const started = await client.shell(sessionId, command);
      setRuns((prev) => [
        ...prev,
        {
          id: started.id,
          status: "running",
          command,
          cwd: "",
          exitCode: null,
          timedOut: false,
          output: "",
          truncated: false,
          durationMs: 0,
        },
      ]);
      setText("");
      watchRun(client, sessionId, started.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  };
  const startEdit = (item: Item) => {
    setEditing(item);
    setText(item.text);
    setAttachments(item.attachments || []);
    // Its terminal results go out again (the server still holds them a day).
    setRuns((item.terminal || []).map((r) => ({ ...r, status: "complete" })));
    setTerminalMode(false);
    request.current = null;
    setTimeout(() => composer.current?.focus(), 0);
  };
  const cancelEdit = () => {
    setEditing(null);
    setText("");
    setAttachments([]);
    request.current = null;
  };
  // Answers of 「插队发送」 last only while their message is still queued.
  useEffect(() => {
    setJumping((j) => {
      const keep = Object.keys(j).filter((k) => queued.some((q) => q.id === k));
      return keep.length === Object.keys(j).length
        ? j
        : Object.fromEntries(keep.map((k) => [k, j[k]]));
    });
    if (!queued.length) setMerging("");
    // ticks last only while their message is still queued.
    setPicked((p) => {
      const keep = Object.keys(p).filter((k) => queued.some((q) => q.id === k));
      return keep.length === Object.keys(p).length
        ? p
        : Object.fromEntries(keep.map((k) => [k, true]));
    });
  }, [queued]);
  /** 「插队发送」 a queued message (R #7). */
  const jumpQueued = async (jid: string, anyway = false) => {
    setJumpWarn(null);
    if (!anyway) {
      // An older control plane's jump stops the running
      // turn and its subagents; it sends their count — ask first. Current
      // servers never stop it and send no count: no question.
      const fresh = await client.queue(sessionId).catch(() => null);
      if (fresh) setQueued(waitingQueue(fresh));
      const count =
        (fresh ?? queued).find((q) => q.id === jid)?.runningSubagents ?? 0;
      if (count > 0) {
        setJumpWarn({ jid, count });
        return;
      }
    }
    setJumping((j) => ({ ...j, [jid]: "…" }));
    setError("");
    try {
      const r = await client.jumpQueued(sessionId, jid);
      // merged into an earlier jump — its card says so.
      setJumping((j) => ({
        ...j,
        [r.mode === "merged" && r.into ? r.into : jid]: jumpNotice(
          r.mode,
          r.reason,
        ),
      }));
      const q = await client.queue(sessionId).catch(() => null);
      if (q) setQueued(waitingQueue(q));
    } catch (e) {
      setJumping((j) => {
        const { [jid]: _, ...rest } = j;
        return rest;
      });
      setError((e as Error).message);
    }
  };
  /**
   * 「合并插队」 (`steer` false) / 「合并追加」 the ticked queued
   * messages, in queue order. A jump that would stop subagents asks first.
   */
  const mergeQueued = async (steer: boolean, anyway = false) => {
    setJumpWarn(null);
    // only rows still in Daisy's queue are merged.
    const ids = queueBulk(queued, picked, {
      busy,
      agent: snap?.session.agent,
      steer: snap?.features?.steer,
    }).jump;
    if (ids.length < 2) return;
    if (!steer && !anyway) {
      const fresh = await client.queue(sessionId).catch(() => null);
      if (fresh) setQueued(waitingQueue(fresh));
      const count = (fresh ?? queued)[0]?.runningSubagents ?? 0;
      if (count > 0) {
        setJumpWarn({ jid: MERGE_WARN, count });
        return;
      }
    }
    setMerging("…");
    setError("");
    try {
      if (steer) {
        const r = await client.mergeSteerQueued(sessionId, { ids });
        setMerging(mergeSteerNotice(r));
      } else {
        const r = await client.mergeJumpQueued(sessionId, { ids });
        setMerging(mergeJumpNotice(r));
      }
      setPicked({});
      const q = await client.queue(sessionId).catch(() => null);
      if (q) setQueued(waitingQueue(q));
    } catch (e) {
      setMerging("");
      setError((e as Error).message);
    }
  };
  /**
   * one row's 「移除」 / 「撤回」 answered (`withdrawing`: the
   * row stays until the agent answers).
   */
  const removedRow = (jid: string, withdrawing?: boolean) => {
    if (withdrawing) {
      setQueued((prev) =>
        prev.map((x) =>
          x.id === jid ? { ...x, appendState: "withdrawing" } : x,
        ),
      );
      return;
    }
    // A wake's marker too: it never started.
    removedItems.current.add(`user:${jid}`);
    removedItems.current.add(`wake:${jid}`);
    setQueued((prev) => prev.filter((x) => x.id !== jid));
  };
  /** 「批量移除」 the ticked rows, each as its own 移除 / 撤回. */
  const removeQueuedMany = async () => {
    const ids = queueBulk(queued, picked, {
      busy,
      agent: snap?.session.agent,
      steer: snap?.features?.steer,
    }).remove;
    if (!ids.length) return;
    setMerging("…");
    setError("");
    try {
      const r = await client.removeQueuedMany(sessionId, { ids });
      for (const x of r.results) if (x.ok) removedRow(x.id, x.withdrawing);
      setMerging(bulkRemoveNotice(r));
      setPicked({});
      const q = await client.queue(sessionId).catch(() => null);
      if (q) setQueued(waitingQueue(q));
    } catch (e) {
      setMerging("");
      setError((e as Error).message);
    }
  };
  /**
   * `immediate` = 立即追加 (steer into the running turn); `jump` = 插队发送
   * (⌘/Ctrl+Enter): queued as usual, then to the head with the running turn
   * stopped (R #7) — attachments and terminal runs go with it.
   */
  const send = async (immediate = false, jump = false) => {
    if (terminalMode && !immediate) return runCommand();
    if (
      blocked ||
      residentPaused ||
      (!text.trim() && !attachments.length && !finished.length)
    )
      return;
    if (text.startsWith("/")) {
      const name = text.slice(1).split(/\s/)[0];
      const command = commands.find((c) => c.name === name);
      if (!command) {
        // P4-11 (C-3): a command whose capability the AI does not declare.
        const needs = COMMAND_FEATURES[name];
        setError(
          needs && !commandOffered(name, snap?.features)
            ? unsupportedMessage(snap?.session.agent, needs[0]!, t)
            : t("ui-chat.command.unknown"),
        );
        return;
      }
      if (command.kind !== "prompt") {
        chooseCommand(command);
        return;
      }
    }
    setSending(true);
    setError("");
    request.current ??= makeId();
    const carried = plan.attach,
      command = plan.command,
      sentRuns = immediate ? [] : finished.map((r) => r.id);
    try {
      if (editing && !immediate) {
        // Rewind to just before the edited message, then send the new text
        // queued behind the rewind job.
        const op = await client.operation(sessionId, "rewind", {
          itemId: editing.id,
          // Claude Code restores its edited files too, when asked;
          // Codex by Daisy's checkpoints.
          ...(rewindFiles &&
          canRewindFiles(snap?.session.agent, snap?.rewindFiles)
            ? { files: true }
            : {}),
        });
        const until = Date.now() + 180_000;
        for (;;) {
          const r = await client.operationStatus(op.sessionId, op.id);
          if (r.result?.error) throw Error(r.result.error);
          if (r.result) break;
          if (["error", "interrupted"].includes(r.status))
            throw Error(t("ui-chat.rewind.failed"));
          if (Date.now() > until) throw Error(t("ui-chat.rewind.stillRunning"));
          await new Promise((r) => setTimeout(r, 500));
        }
        setEditing(null);
      }
      const accepted = immediate
        ? await client.steer(sessionId, text, request.current, carried)
        : await client.send(
            sessionId,
            text,
            attachments.map((a) => a.id),
            request.current,
            busy || editing ? "queue" : "normal",
            carried,
            sentRuns,
          );
      // a 立即追加 into someone else's turn became a queued
      // message (first after it) — its card says why.
      const fellBack =
        immediate && "queued" in accepted && !!(accepted as any).queued;
      if (fellBack)
        setJumping((j) => ({
          ...j,
          [accepted.id]: String((accepted as any).reason || ""),
        }));
      const itemId = `${immediate && !fellBack ? "input" : "user"}:${accepted.id}`;
      setGate((g) => gateAfterSend(g, { carried, itemId, command }));
      setContextOpen(false);
      setContextSwitched(false);
      if (accepted.status === "pending") pendingItems.current.add(itemId);
      if (carried) callbacks.current.onContextSent?.(carried);
      setText("");
      setAttachments([]);
      setRuns((prev) => prev.filter((r) => !sentRuns.includes(r.id)));
      request.current = null;
      stickRef.current = true;
      setStick(true);
      if (jump && !immediate && accepted.status === "pending")
        void jumpQueued(accepted.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  };
  const steerState = {
    busy,
    terminalMode,
    editing: !!editing,
    finished: finished.length,
    agent: snap?.session.agent,
    hasText: !!text.trim(),
    attachments: attachments.length,
    // P4-11: the declared 运行中追加, not the agent's name.
    steer: snap?.features?.steer,
  };
  const busyHint = busyComposerHint(
    steerState,
    Platform.OS === "web" && keyboardDevice(),
  );
  const pick = () =>
    addFiles(() =>
      adapters.pickFiles ? adapters.pickFiles() : defaultPickFiles(),
    );
  /** Picked, pasted or dropped files: one upload path and limit. */
  const addFiles = async (
    read: () => Promise<DaisyPickedFile[]> | DaisyPickedFile[],
  ) => {
    setUploading(true);
    try {
      const files = await read();
      const out: Attachment[] = [];
      for (const a of files) {
        if ((a.size ?? a.blob?.size ?? 0) > 8 * 1024 * 1024)
          throw Error(t("ui-chat.attachment.tooLarge"));
        out.push(
          await client.upload(
            a.name,
            a.mimeType || a.blob?.type || "application/octet-stream",
            await pickedBase64(a),
          ),
        );
      }
      setAttachments((prev) => [...prev, ...out].slice(0, 8));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploading(false);
    }
  };
  // Web: a clipboard screenshot pasted into the box, or files dropped on
  // it, go in like 「＋ 附件」 (not in 在终端执行, which has no attachments).
  const dropIn = useRef({ addFiles, off: false });
  dropIn.current = { addFiles, off: terminalMode || blocked || uploading };
  useEffect(() => {
    const el = composer.current as unknown as HTMLElement | null;
    if (
      Platform.OS !== "web" ||
      !el ||
      typeof el.addEventListener !== "function"
    )
      return;
    const paste = (e: ClipboardEvent) => {
      const files = pastedImages(e.clipboardData);
      if (!files.length || dropIn.current.off) return;
      // After the browser pasted the text part, if any.
      setTimeout(() => void dropIn.current.addFiles(() => files), 0);
    };
    const over = (e: DragEvent) => {
      if (dragHasFiles(e.dataTransfer) && !dropIn.current.off)
        e.preventDefault();
    };
    const drop = (e: DragEvent) => {
      const files = droppedFiles(e.dataTransfer);
      if (!files.length || dropIn.current.off) return;
      e.preventDefault();
      void dropIn.current.addFiles(() => files);
    };
    el.addEventListener("paste", paste);
    el.addEventListener("dragover", over);
    el.addEventListener("drop", drop);
    return () => {
      el.removeEventListener("paste", paste);
      el.removeEventListener("dragover", over);
      el.removeEventListener("drop", drop);
    };
  }, []);
  return (
    <KeyboardAvoidingView
      {...focusScope}
      style={{ flex: 1, backgroundColor: C.paper }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      {/* Web: files dropped anywhere on this conversation. Native: nothing. */}
      <SessionDropZone title={snap?.session.title ?? ""} onError={setError} />
      {chrome === "full" ? (
        <View
          style={[
            s.row,
            {
              flexWrap: "wrap",
              paddingHorizontal: sp(width < 700 ? 16 : 32),
              paddingVertical: sp(16),
              borderBottomWidth: 1,
              borderColor: C.line,
            },
          ]}
        >
          <View style={{ flex: 1, minWidth: 130, gap: 4 }}>
            <Text
              numberOfLines={1}
              style={{ fontSize: 16, fontWeight: "600", color: C.ink }}
            >
              {snap?.session.title ||
                (fatalLoad
                  ? t("ui-chat.unavailable")
                  : t("ui-chat.connectingSession"))}
            </Text>
            <Text style={{ fontSize: 11, color: C.muted }}>
              {snap
                ? t("ui-chat.header.subline", {
                    agent: labels[snap.session.agent] || snap.session.agent,
                    native: snap.session.nativeId
                      ? t("ui-chat.header.nativeLinked")
                      : t("ui-chat.header.nativePending"),
                  })
                : ""}
              {connectionText}
            </Text>
          </View>
          {phaseBadge}
          <Button
            variant="outline"
            disabled={blocked}
            onPress={() => setPanel("help")}
          >
            {t("ui-chat.header.commands")}
          </Button>
          {headerActions}
        </View>
      ) : null}
      {/* A resident's tasks are on its status strip (one row). */}
      {chrome === "full" &&
      snap?.session.task &&
      snap.session.kind !== "resident" ? (
        <View
          style={{
            backgroundColor: C.surfaceAlt,
            paddingHorizontal: sp(24),
            paddingVertical: sp(10),
            borderBottomWidth: 1,
            borderColor: C.line,
          }}
        >
          {openTask ? (
            <Pressable
              testID="task-banner-link"
              accessibilityRole="link"
              accessibilityLabel={t("ui-chat.task.openA11y", {
                banner: copy.taskBanner,
                title: snap.session.task.title,
              })}
              onPress={openTask}
              style={{ alignSelf: "flex-start" }}
            >
              <Text
                style={{
                  fontSize: 11,
                  color: C.accent,
                  textDecorationLine: "underline",
                }}
              >
                {copy.taskBanner} · {snap.session.task.title} ↗
              </Text>
            </Pressable>
          ) : (
            <Text style={{ fontSize: 11, color: C.muted }}>
              {copy.taskBanner} · {snap.session.task.title}
            </Text>
          )}
        </View>
      ) : null}
      {reading.control}
      <View style={{ flex: 1, minHeight: 0 }}>
        <FreshnessBar
          kind={freshKind}
          sessionId={sessionId}
          text={snap ? freshText : ""}
          presence={presence}
          presenceText={presenceText}
        />
        <ScrollView
          ref={scroll}
          style={{ flex: 1 }}
          contentContainerStyle={{
            paddingHorizontal: sp(width < 700 ? 20 : 38),
            paddingVertical: sp(20),
            maxWidth: reading.maxWidth,
            width: "100%",
            alignSelf: "center",
            flexGrow: 1,
          }}
          onScroll={(e) => {
            // Parked (kept alive, hidden): its box may be emptied by the
            // browser; that is not the reader scrolling away.
            if (activity && !activity.get()) return;
            const { layoutMeasurement, contentOffset, contentSize } =
              e.nativeEvent;
            const at =
              layoutMeasurement.height + contentOffset.y >=
              contentSize.height - 100;
            // Only moving up leaves the end: a scroll event that
            // arrives after the content grew (more turns, the full window)
            // but before it was pinned again reads "not at end" without the
            // reader having moved; it no longer unpins the conversation.
            const up = contentOffset.y < lastOffset.current - 2;
            lastOffset.current = contentOffset.y;
            // The reader moved on after a held position was restored.
            if (up && anchor.current?.applied) anchor.current = null;
            const next = at ? true : up ? false : stickRef.current;
            if (next !== stickRef.current) {
              stickRef.current = next;
              setStick(next);
            }
            if (
              up &&
              !next &&
              nearTop(contentOffset.y, layoutMeasurement.height)
            )
              void loadEarlier(contentSize.height - contentOffset.y);
          }}
          scrollEventThrottle={100}
          onContentSizeChange={(_w: number, h: number) => {
            contentHeight.current = h;
            const a = anchor.current;
            if (a && Date.now() > a.until) anchor.current = null;
            else if (a && !stickRef.current) {
              // Turns were added above: keep the same distance from the end.
              const y = keepPosition(h, a.fromBottom);
              a.applied = true;
              lastOffset.current = y;
              scroll.current?.scrollTo({ y, animated: false });
              return;
            }
            if (stickRef.current)
              scroll.current?.scrollToEnd({ animated: false });
          }}
        >
          {loadError && !snap ? (
            <View
              testID="chat-load-error"
              accessibilityRole="alert"
              style={{
                flex: 1,
                justifyContent: "center",
                alignItems: "center",
                paddingVertical: 65,
                gap: 12,
              }}
            >
              <Text style={{ fontSize: 26, color: C.muted }}>
                {loadError.status === 403 ? "🔒" : fatalLoad ? "∅" : "⋯"}
              </Text>
              <Text
                style={{
                  fontSize: 15,
                  fontWeight: "600",
                  color: C.ink,
                  textAlign: "center",
                  maxWidth: 420,
                }}
              >
                {loadErrorText}
              </Text>
              {!fatalLoad ? (
                // Retried on its own every few seconds; this asks now.
                <Button
                  testID="chat-load-retry"
                  variant="outline"
                  onPress={() => watchRef.current?.refresh()}
                >
                  {t("ui-chat.retry")}
                </Button>
              ) : null}
            </View>
          ) : !snap ? (
            <TranscriptSkeleton hint={loadingLate ? copy.loadingStatus : ""} />
          ) : !snap.items.length ? (
            <View
              style={{
                flex: 1,
                justifyContent: "center",
                alignItems: "center",
                paddingVertical: 65,
                gap: 12,
              }}
            >
              <View
                style={{
                  width: 58,
                  height: 58,
                  borderRadius: rad(18),
                  backgroundColor: C.soft,
                  justifyContent: "center",
                  alignItems: "center",
                }}
              >
                <Text style={{ fontSize: 30, color: C.accent }}>✳</Text>
              </View>
              <Text style={{ fontSize: 22, fontWeight: "600", color: C.ink }}>
                {copy.emptyTitle}
              </Text>
              <Text style={[s.muted, { textAlign: "center", maxWidth: 360 }]}>
                {copy.emptyBody}
              </Text>
            </View>
          ) : null}
          {firstTurn > 0 || snap?.partial ? (
            <Pressable
              testID="chat-earlier-turns"
              accessibilityRole="button"
              accessibilityState={{ busy: loadingOlder }}
              disabled={loadingOlder}
              onPress={() => void loadEarlier()}
              style={{ alignSelf: "center", paddingVertical: 8 }}
            >
              <Text style={{ fontSize: 12, color: C.accent }}>
                {loadingOlder
                  ? t("ui-chat.earlier.loading")
                  : firstTurn > 0
                    ? t(
                        snap?.partial
                          ? "ui-chat.earlier.showLoaded"
                          : "ui-chat.earlier.showTotal",
                        {
                          count: Math.min(40, firstTurn),
                          total: groupedTurns.length,
                        },
                      )
                    : t("ui-chat.earlier.load")}
              </Text>
            </Pressable>
          ) : null}
          {(() => {
            if (!snap) return null;
            const turns = groupedTurns;
            const records = snap.approvals
              .filter((a) => a.status !== "pending")
              .sort((a, b) => a.createdAt - b.createdAt);
            // a resident's chat shows people's words and what it
            // said (say); everything else is its run log (运行日志).
            const quiet = snap.session.kind === "resident" && !showLog;
            return turns.map((turn, i) => {
              if (i < firstTurn) return null;
              if (quiet) {
                const shown = turn.filter(
                  (x) =>
                    residentVisible(x) ||
                    x.id.startsWith("budget:") ||
                    x.id.startsWith("resident-closed:"),
                );
                if (!shown.length) return null;
                return (
                  <View key={turn[0].id} testID="resident-turn">
                    {shown.map((item) => (
                      <Message
                        key={item.id}
                        item={item}
                        client={client}
                        agent={snap.session.agent}
                      />
                    ))}
                  </View>
                );
              }
              const from = i ? turn[0].createdAt : -Infinity,
                to = turns[i + 1]?.[0].createdAt ?? Infinity,
                decided = records.filter(
                  (a) => a.createdAt >= from && a.createdAt < to,
                );
              const activity = turn.filter(
                (x) => x.kind === "tool" || x.kind === "thinking",
              );
              const messages = turn.filter(
                (x) => x.kind !== "tool" && x.kind !== "thinking",
              );
              const user = messages.find((x) => x.kind === "user"),
                wake = messages.find((x) => x.category === "wake"),
                // The running turn shows on the trace bar above the composer.
                live = busy && i === liveTurn;
              return (
                <View key={turn[0].id}>
                  {wake ? (
                    <WakeMarker
                      item={wake}
                      // Still queued behind the running turn: not delivered.
                      waiting={queued.some((q) => `wake:${q.id}` === wake.id)}
                    />
                  ) : null}
                  {user ? (
                    <Message
                      item={user}
                      client={client}
                      agent={snap.session.agent}
                      waiting={
                        pendingItems.current.has(user.id) ||
                        queued.some((q) => `user:${q.id}` === user.id)
                      }
                      onEdit={
                        !busy &&
                        !sending &&
                        !editing &&
                        !queued.length &&
                        user.status === "accepted" &&
                        user.id.startsWith("user:") &&
                        // P4-11: edit-and-resend is a 「回退」.
                        commandOffered("rewind", snap.features)
                          ? () => startEdit(user)
                          : undefined
                      }
                    />
                  ) : null}
                  {activity.length && !live ? (
                    // One summary line per finished turn, opening to
                    // the full track; the authorization joins the line
                    // (「✓ 运行了 pwd（允许本次）」) instead of a second row.
                    <ActivityTrack
                      items={activity}
                      active={false}
                      // N-3: only the turn that was stopped shows 「已中断」.
                      terminal={turnEnd(
                        turn,
                        i === liveTurn ? snap.session.status : undefined,
                      )}
                      compact
                      approvals={decided}
                    />
                  ) : null}
                  {activity.length && !live
                    ? null
                    : decided.map((a) => (
                        <ApprovalRecord key={a.id} approval={a} />
                      ))}
                  {messages
                    .filter((x) => x !== user && x !== wake)
                    .map((item) =>
                      item.category === "compact" ? (
                        <CompactNotice key={item.id} item={item} />
                      ) : (
                        <Message
                          key={item.id}
                          item={item}
                          client={client}
                          agent={snap.session.agent}
                        />
                      ),
                    )}
                </View>
              );
            });
          })()}
          {snap?.approvals
            .filter((a) => a.status === "pending")
            .map((a) => (
              <ApprovalCard
                key={a.id}
                approval={a}
                sid={sessionId}
                client={client}
                onError={setError}
                // What changed since the held cursor, not the
                // whole conversation.
                onStale={() => watchRef.current?.refresh()}
              />
            ))}
        </ScrollView>
      </View>
      <View
        style={{
          paddingHorizontal: sp(width < 700 ? 14 : 30),
          paddingTop: sp(8),
          paddingBottom: sp(Platform.OS === "web" ? 18 : 10),
          maxWidth: reading.maxWidth,
          width: "100%",
          alignSelf: "center",
          gap: 8,
        }}
      >
        <ErrorBox text={loadError ? "" : error} />
        {snap?.session.identityMove && snap.session.status === "error" ? (
          <IdentityFresh
            client={client}
            sid={sessionId}
            onError={setError}
            onDone={() => watchRef.current?.refresh()}
          />
        ) : null}
        {traceOpen && snap ? (
          <View
            testID="trace-expanded"
            style={{
              borderWidth: 1,
              borderColor: C.line,
              borderRadius: rad(10),
              paddingHorizontal: sp(10),
              maxHeight: 320,
            }}
          >
            {lastTurn.activity.length ? (
              <ScrollView>
                <ActivityTrack
                  items={lastTurn.activity}
                  active={busy}
                  terminal={snap.session.status}
                  approvals={lastTurn.decided}
                  initialExpanded
                />
              </ScrollView>
            ) : (
              <Text style={[s.muted, { paddingVertical: 12 }]}>
                {t("ui-chat.trace.none")}
              </Text>
            )}
          </View>
        ) : null}
        <View
          testID="chat-status-line"
          style={{ paddingHorizontal: 6, gap: 3 }}
        >
          <View style={[s.row, { gap: 8 }]}>
            <Pressable
              testID="trace-toggle"
              accessibilityRole="button"
              accessibilityLabel={
                traceOpen ? t("ui-chat.trace.closeLarge") : t("ui-chat.trace.openLarge")
              }
              accessibilityState={{ expanded: traceOpen }}
              onPress={() => setTraceOpen(!traceOpen)}
              style={[s.row, { gap: 7, paddingVertical: 3 }]}
            >
              {busy ? (
                <View testID="chat-working">
                  <TraceDots
                    active
                    color={
                      snap?.session.status === "waiting" ? C.orange : undefined
                    }
                  />
                </View>
              ) : (
                <TraceDots
                  active={!fatalLoad && (sending || connection !== "live")}
                  color={offline || loadError ? C.red : undefined}
                />
              )}
              <Text style={{ fontSize: 11, color: C.faint }}>
                {traceOpen ? "↙" : "↗"}
              </Text>
            </Pressable>
            <View style={{ flex: 1 }} />
            {snap && commandOffered("model", snap.features) ? (
              <ModelChip
                session={snap.session}
                onPress={() => setPanel("model")}
              />
            ) : null}
            {snap ? (
              <LiveBadge
                live={snap.session.live}
                scheduler={schedulerPendingOf(snap.session)}
                onOffline={() => client.goOffline(sessionId)}
                loadActivity={loadActivity}
                agent={snap.session.agent}
                onStop={(taskId) => client.stopBackground(sessionId, taskId)}
              />
            ) : null}
            {snap ? (
              // used / the Agent's real trigger point, a bubble on tap.
              <ContextGaugeButton session={snap.session} items={snap.items} />
            ) : null}
            {chrome === "compact" ? (
              <>
                {phase && phase !== "idle" && phase !== "completed"
                  ? phaseBadge
                  : null}
                <Button
                  variant="outline"
                  disabled={blocked}
                  onPress={() => setPanel("help")}
                >
                  {t("ui-chat.header.commands")}
                </Button>
                {headerActions}
              </>
            ) : null}
          </View>
          <TraceDetail
            fixed={traceFixed}
            busy={busy}
            activity={lastTurn.activity}
            streaming={lastTurn.streaming}
            endedAt={lastTurn.endedAt}
            pending={backgroundCount(snap?.session)}
          />
        </View>
        {preview && snap && !(compact && busy) ? (
          <View
            style={{
              backgroundColor: C.bg,
              padding: sp(14),
              borderRadius: rad(12),
              gap: 8,
            }}
          >
            <Text style={s.label}>{copy.previewTitle}</Text>
            {(() => {
              const out = buildPrompt(
                text,
                snap.session.task,
                !(snap.session.contextDelivered ?? !!snap.session.nativeId),
                [],
                plan.attach,
                finished,
              );
              // 没有任何附加内容时，发出去的就是输入框里的字：只说一句，不再把正文重复一遍
              return out.trim() === text.trim() ? (
                <Text testID="preview-same" style={s.muted}>
                  {copy.previewSame ?? t("ui-copy.previewSame")}
                </Text>
              ) : (
                <ScrollView style={{ maxHeight: 180 }}>
                  <Text selectable style={s.mono}>
                    {out}
                  </Text>
                </ScrollView>
              );
            })()}
            {attachments.length ? (
              <Text style={s.muted}>
                {copy.attachmentsNote.replace(
                  "{count}",
                  String(attachments.length),
                )}
              </Text>
            ) : null}
          </View>
        ) : null}
        {fitted.invalid && snap ? (
          <Text
            testID="context-invalid"
            style={{ fontSize: 11, color: C.faint, paddingHorizontal: 4 }}
          >
            {copy.contextInvalid}
          </Text>
        ) : null}
        {context && snap ? (
          <ContextBar
            context={context}
            attached={plan.attached}
            skipped={plan.skipped}
            command={plan.command}
            // 「已附带」 wins: a switch only shows until something is sent.
            switched={contextSwitched && !plan.attached}
            trimmed={fitted.trimmed}
            open={contextOpen}
            lines={compact ? 4 : 8}
            onToggle={() => setContextOpen(!contextOpen)}
            onSkip={() => setGate((g) => ({ ...g, skipKey: context.key }))}
            onRestore={() => setGate((g) => ({ ...g, skipKey: null }))}
          />
        ) : null}
        {editing ? (
          <View
            testID="editing-banner"
            style={[
              s.row,
              {
                backgroundColor: C.bg,
                borderRadius: rad(10),
                paddingHorizontal: sp(12),
                paddingVertical: sp(8),
              },
            ]}
          >
            <Text style={{ flex: 1, fontSize: 12, color: C.muted }}>
              {editBannerText(
                snap?.session.agent,
                rewindFiles,
                snap?.rewindFiles,
              )}
            </Text>
            {canRewindFiles(snap?.session.agent, snap?.rewindFiles) ? (
              <Button
                testID="editing-rewind-files"
                variant="ghost"
                onPress={() => setRewindFiles((v) => !v)}
              >
                {rewindFiles
                  ? REWIND_WORDS.filesToggleOn
                  : REWIND_WORDS.filesToggle}
              </Button>
            ) : null}
            <Button variant="ghost" onPress={cancelEdit}>
              {t("ui-chat.edit.cancel")}
            </Button>
          </View>
        ) : null}
        <View
          testID="composer-box"
          style={{
            borderWidth: terminalMode ? 2 : 1,
            borderColor: terminalMode
              ? TERMINAL.line
              : focused
                ? C.accent
                : C.lineStrong,
            borderRadius: rad(15),
            backgroundColor: terminalMode ? TERMINAL.field : C.field,
            // Tight: the drag bar lies over the
            // top padding (./composer-resize), the input is one line.
            paddingHorizontal: sp(10),
            paddingTop: sp(10),
            paddingBottom: sp(6),
            gap: sp(6),
            opacity: fatalLoad ? 0.6 : 1,
          }}
        >
          <ComposerResizeBar
            size={composerSize}
            color={composerSize.pulled ? C.accent : C.line}
            accent={C.accent}
          />
          {terminalMode ? (
            <Text
              testID="terminal-warning"
              style={{ fontSize: 11, color: TERMINAL.faint }}
            >
              {t("ui-chat.terminalMode.warning")}
            </Text>
          ) : null}
          {runs.length ? (
            <View testID="terminal-runs" style={{ gap: 6 }}>
              <View style={[s.row, { flexWrap: "wrap" }]}>
                {runs.map((r) => (
                  <View
                    key={r.id}
                    style={[
                      s.row,
                      {
                        gap: 4,
                        borderWidth: 1,
                        borderColor: C.lineStrong,
                        borderRadius: rad(8),
                        paddingHorizontal: 8,
                        paddingVertical: 3,
                        backgroundColor: C.bg,
                        maxWidth: "100%",
                      },
                    ]}
                  >
                    <Pressable
                      accessibilityRole="button"
                      onPress={() => setOpenRun(openRun === r.id ? null : r.id)}
                      style={{ flexShrink: 1 }}
                    >
                      <Text
                        numberOfLines={1}
                        style={[s.mono, { fontSize: 12 }]}
                      >
                        {r.status === "running" || r.status === "queued"
                          ? "⏳"
                          : "▣"}{" "}
                        $ {r.command}
                        {r.status === "running" || r.status === "queued"
                          ? t("ui-chat.terminalMode.running")
                          : ` · ${exitText(r)}`}
                      </Text>
                    </Pressable>
                    {r.status === "running" || r.status === "queued" ? null : (
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={t("ui-chat.terminalMode.remove")}
                        onPress={() =>
                          setRuns((prev) => prev.filter((x) => x.id !== r.id))
                        }
                      >
                        <Text style={{ fontSize: 12, color: C.muted }}>×</Text>
                      </Pressable>
                    )}
                  </View>
                ))}
              </View>
              {(() => {
                const r = runs.find((x) => x.id === openRun);
                return r && r.status !== "running" ? (
                  <TerminalOutput r={r} />
                ) : null;
              })()}
              {finished.length ? (
                <Text
                  testID="terminal-runs-note"
                  style={{
                    fontSize: 11,
                    color: terminalMode ? TERMINAL.faint : C.muted,
                  }}
                >
                  {t("ui-chat.terminalMode.runsNote", {
                    count: finished.length,
                  })}
                </Text>
              ) : null}
            </View>
          ) : null}
          {attachments.length ? (
            <View style={[s.row, { flexWrap: "wrap" }]}>
              {attachments.map((a) => (
                <Pressable
                  key={a.id}
                  onPress={() =>
                    setAttachments((x) => x.filter((v) => v.id !== a.id))
                  }
                >
                  <Badge text={a.name + " ×"} />
                </Pressable>
              ))}
            </View>
          ) : null}
          {slashOpen ? (
            <CommandPalette
              commands={commands}
              query={query || ""}
              index={slashIndex}
              onSelect={chooseCommand}
            />
          ) : null}
          {queued.length ? (
            <View style={{ gap: 6 }}>
              <Text style={s.muted}>
                {t("ui-chat.queue.summary", {
                  count: queued.length,
                  state: busy
                    ? t("ui-chat.queue.afterTurn")
                    : t("ui-chat.queue.paused"),
                })}
              </Text>
              {!busy ? (
                <Button
                  onPress={() =>
                    void client
                      .resumeQueue(sessionId)
                      .catch((e) => setError(e.message))
                  }
                >
                  {t("ui-chat.queue.resume")}
                </Button>
              ) : null}
              {queued.filter(queueRowSelectable).length > 1 ? (
                // tick several, then 「合并插队」 (one message, one
                // interruption) or 「合并追加」 (all plain text, into the turn).
                <View
                  testID="queue-merge-bar"
                  style={[s.row, { flexWrap: "wrap" }]}
                >
                  {(() => {
                    // rows still waiting; 批量移除 / 合并插队 /
                    // 合并追加 by the server's eligibility.
                    const selectable = queued.filter(queueRowSelectable);
                    const bulk = queueBulk(queued, picked, {
                      busy,
                      agent: snap?.session.agent,
                      steer: snap?.features?.steer,
                    });
                    const all = bulk.remove.length === selectable.length;
                    const blocked = queued.find(
                      (q) => q.jumpBlocked,
                    )?.jumpBlocked;
                    return (
                      <>
                        <Button
                          testID="queue-pick-all"
                          variant="ghost"
                          onPress={() =>
                            setPicked(
                              all
                                ? {}
                                : Object.fromEntries(
                                    selectable.map((q) => [q.id, true]),
                                  ),
                            )
                          }
                        >
                          {all ? t("ui-chat.queue.unpickAll") : t("ui-chat.queue.pickAll")}
                        </Button>
                        {bulk.remove.length ? (
                          <Button
                            testID="queue-remove-many"
                            variant="ghost"
                            busy={merging === "…"}
                            onPress={() => void removeQueuedMany()}
                          >
                            {t("ui-chat.queue.removeMany", {
                              count: bulk.remove.length,
                            })}
                          </Button>
                        ) : null}
                        {bulk.jump.length > 1 && blocked ? (
                          <Text style={{ fontSize: 11, color: C.muted }}>
                            {blocked}
                          </Text>
                        ) : bulk.jump.length > 1 ? (
                          <Button
                            testID="queue-merge-jump"
                            variant="soft"
                            busy={merging === "…"}
                            onPress={() => void mergeQueued(false)}
                          >
                            {t("ui-chat.queue.mergeJump", {
                              count: bulk.jump.length,
                            })}
                          </Button>
                        ) : null}
                        {bulk.steer ? (
                          <Button
                            testID="queue-merge-steer"
                            variant="ghost"
                            busy={merging === "…"}
                            onPress={() => void mergeQueued(true)}
                          >
                            {bulk.steerCount < bulk.jump.length
                              ? t("ui-chat.queue.mergeSteerSome", {
                                  some: bulk.steerCount,
                                  count: bulk.jump.length,
                                })
                              : t("ui-chat.queue.mergeSteer", {
                                  count: bulk.jump.length,
                                })}
                          </Button>
                        ) : null}
                        {!bulk.remove.length ? (
                          <Text style={{ fontSize: 11, color: C.muted }}>
                            {t("ui-chat.queue.pickHint")}
                          </Text>
                        ) : bulk.steer && bulk.steerCount < bulk.jump.length ? (
                          <Text
                            testID="queue-merge-steer-hint"
                            style={{ fontSize: 11, color: C.muted }}
                          >
                            {t("ui-chat.queue.steerLeft", {
                              count: bulk.jump.length - bulk.steerCount,
                            })}
                          </Text>
                        ) : null}
                        {merging && merging !== "…" ? (
                          <Text
                            testID="queue-merge-notice"
                            style={{ fontSize: 11, color: C.muted }}
                          >
                            {merging}
                          </Text>
                        ) : null}
                      </>
                    );
                  })()}
                </View>
              ) : null}
              {queued.map((q, n) => (
                <View key={q.id} style={s.row}>
                  {queued.filter(queueRowSelectable).length > 1 &&
                  queueRowSelectable(q) ? (
                    <Pressable
                      testID={`queue-pick-${q.id}`}
                      accessibilityRole="checkbox"
                      accessibilityState={{ checked: !!picked[q.id] }}
                      accessibilityLabel={t("ui-chat.queue.pickA11y", {
                        text: q.text.slice(0, 40),
                      })}
                      onPress={() =>
                        setPicked((p) => {
                          const { [q.id]: on, ...rest } = p;
                          return on ? rest : { ...p, [q.id]: true };
                        })
                      }
                    >
                      <Text style={{ color: C.accent }}>
                        {picked[q.id] ? "☑" : "☐"}
                      </Text>
                    </Pressable>
                  ) : null}
                  <QueueRowText
                    q={q}
                    prefix={
                      (q.nextTurn || q.appended
                        ? ""
                        : q.jump || (jumping[q.id] && jumping[q.id] !== "…")
                          ? t("ui-chat.queue.jumpPrefix")
                          : "") +
                      (q.merged
                        ? t("ui-chat.queue.mergedPrefix", { count: q.merged + 1 })
                        : "") +
                      (q.from ? `${q.from} · ` : "")
                    }
                    expanded={!!opened[q.id]}
                    onToggle={() =>
                      setOpened((o) => {
                        const { [q.id]: on, ...rest } = o;
                        return on ? rest : { ...o, [q.id]: true };
                      })
                    }
                  />
                  {q.appended ? (
                    // delivered into the running turn (the agent's
                    // own queue), read at its next tool boundary.
                    <Text
                      testID={`queue-appended-${q.id}`}
                      style={{ fontSize: 11, color: C.accent }}
                    >
                      {queueRowLabel(q)}
                    </Text>
                  ) : q.nextTurn ? (
                    // it could not go in with the jump ahead — a
                    // later turn of its own, not a pending 插队.
                    <Text
                      testID={`queue-next-turn-${q.id}`}
                      style={{ fontSize: 11, color: C.muted }}
                    >
                      {nextTurnLabel(q)}
                    </Text>
                  ) : jumping[q.id] && jumping[q.id] !== "…" ? (
                    <Text style={{ fontSize: 11, color: C.muted }}>
                      {jumping[q.id]}
                    </Text>
                  ) : q.jumpBlocked && (busy || n > 0) ? (
                    // no button that would fail — say why instead.
                    <Text
                      testID={`queue-jump-blocked-${q.id}`}
                      style={{ fontSize: 11, color: C.muted }}
                    >
                      {q.jumpBlocked}
                    </Text>
                  ) : busy || n > 0 ? (
                    // Into the running turn without
                    // stopping it (else first after it); attachments and
                    // terminal runs go with it.
                    <Button
                      testID={`queue-jump-${q.id}`}
                      variant="soft"
                      busy={jumping[q.id] === "…"}
                      accessibilityLabel={t("ui-chat.queue.jumpA11y", {
                        text: q.text.slice(0, 40),
                      })}
                      onPress={() => void jumpQueued(q.id)}
                    >
                      {t("ui-chat.queue.jump")}
                    </Button>
                  ) : null}
                  {queueRemoveLabel(q) ? (
                    // 「撤回」 = an appended row asked back before
                    // the agent reads it; 「移除」 a queued one.
                    <Button
                      testID={`queue-remove-${q.id}`}
                      variant="ghost"
                      onPress={() =>
                        void client
                          .removeQueued(sessionId, q.id)
                          .then((r) => removedRow(q.id, r?.withdrawing))
                          .catch((e) => setError(e.message))
                      }
                    >
                      {queueRemoveLabel(q)}
                    </Button>
                  ) : null}
                </View>
              ))}
            </View>
          ) : null}
          {jumpWarn &&
          (jumpWarn.jid === MERGE_WARN ||
            queued.some((q) => q.id === jumpWarn.jid)) ? (
            <View testID="jump-subagents" style={[s.row, { flexWrap: "wrap" }]}>
              <Text
                style={{ flex: 1, minWidth: 200, fontSize: 12, color: C.ink }}
              >
                {fillCopy(copy.jumpSubagentsWarning, { count: jumpWarn.count })}
              </Text>
              <Button
                testID="jump-subagents-later"
                variant="soft"
                onPress={() => setJumpWarn(null)}
              >
                {copy.jumpAfterTurn}
              </Button>
              <Button
                testID="jump-subagents-anyway"
                variant="ghost"
                onPress={() =>
                  void (jumpWarn.jid === MERGE_WARN
                    ? mergeQueued(false, true)
                    : jumpQueued(jumpWarn.jid, true))
                }
              >
                {copy.jumpAnyway}
              </Button>
            </View>
          ) : null}
          {confirmJump && busy ? (
            <View testID="jump-confirm" style={[s.row, { flexWrap: "wrap" }]}>
              <Text
                style={{ flex: 1, minWidth: 200, fontSize: 12, color: C.ink }}
              >
                {t("ui-chat.jumpConfirm.note")}
              </Text>
              <Button
                testID="jump-confirm-ok"
                variant="soft"
                onPress={() => {
                  rememberJumpConfirmed();
                  setConfirmJump(false);
                  void send(false, true);
                }}
              >
                {t("ui-chat.jumpConfirm.ok")}
              </Button>
              <Button
                testID="jump-confirm-cancel"
                variant="ghost"
                onPress={() => {
                  setConfirmJump(false);
                  setTimeout(() => composer.current?.focus(), 0);
                }}
              >
                {t("ui-chat.cancel")}
              </Button>
            </View>
          ) : null}
          {residentPaused ? (
            <View
              testID="composer-resident-paused"
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 8,
                flexWrap: "wrap",
              }}
            >
              <Text style={{ fontSize: 12, color: C.muted, flex: 1 }}>
                {t("ui-chat.resident.paused")}
              </Text>
            </View>
          ) : null}
          <TextInput
            ref={composer}
            testID="composer"
            editable={!blocked && !residentPaused}
            aria-disabled={blocked || residentPaused}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            accessibilityLabel={t("ui-chat.composer.label")}
            value={text}
            onChangeText={(v) => {
              setText(v);
              setSlashIndex(0);
              setSlashDismissed(false);
              request.current = null;
            }}
            placeholder={
              fatalLoad
                ? t("ui-chat.composer.cannotOpen")
                : residentPaused
                  ? t("ui-chat.composer.paused")
                  : offline
                    ? copy.reconnecting
                    : blocked
                      ? copy.loadingStatus
                      : terminalMode
                        ? t("ui-chat.composer.terminal")
                        : copy.composerPlaceholder
            }
            placeholderTextColor={terminalMode ? TERMINAL.faint : C.faint}
            multiline
            onContentSizeChange={composerSize.onContentSizeChange}
            style={{
              fontSize: terminalMode ? 14 : 16,
              lineHeight: 26,
              fontFamily: terminalMode ? font.mono : font.family,
              ...(Platform.OS === "web" ? { outlineStyle: "none" as any } : {}),
              color: terminalMode ? TERMINAL.ink : C.ink,
              height: composerSize.height,
              padding: 5,
              textAlignVertical: "top",
            }}
            onKeyPress={(e) => {
              const key = e.nativeEvent as any;
              if (
                slashOpen &&
                ["ArrowDown", "ArrowUp", "Enter", "Escape"].includes(key.key)
              ) {
                e.preventDefault();
                if (key.key === "Escape") setSlashDismissed(true);
                else if (key.key === "Enter" && matches.length)
                  chooseCommand(
                    matches[Math.min(slashIndex, matches.length - 1)],
                  );
                else
                  setSlashIndex(
                    (i) =>
                      (i +
                        (key.key === "ArrowDown" ? 1 : -1) +
                        Math.max(1, matches.length)) %
                      Math.max(1, matches.length),
                  );
                return;
              }
              if (
                Platform.OS === "web" &&
                key.key === "Enter" &&
                !key.shiftKey &&
                !key.isComposing
              ) {
                e.preventDefault();
                // ⌘/Ctrl+Enter while a turn runs: 插队发送 (R #7), asked
                // once before the first time (review M3).
                const jump = busy && !editing && !!(key.metaKey || key.ctrlKey);
                if (sending) return;
                if (jump && !jumpConfirmed()) setConfirmJump(true);
                else void send(false, jump);
              }
            }}
          />
          <View
            testID="composer-actions"
            // compact: one line in every state (attach / preview / stop /
            // steer / queue) so the composer never changes height (review S4).
            style={[
              s.row,
              compact ? { flexWrap: "nowrap", gap: 6 } : { flexWrap: "wrap" },
            ]}
          >
            {terminalMode ? null : (
              <Button
                variant="outline"
                busy={uploading}
                disabled={blocked}
                onPress={() => void pick()}
                accessibilityLabel={compact ? t("ui-chat.composer.attach") : undefined}
              >
                {compact
                  ? t("ui-chat.composer.attachCompact")
                  : t("ui-chat.composer.attachButton")}
              </Button>
            )}
            {(compact && busy) || terminalMode ? null : (
              <Button
                variant="outline"
                disabled={blocked}
                onPress={() => setPreview(!preview)}
              >
                {preview ? t("ui-chat.composer.hidePreview") : t("ui-chat.composer.showPreview")}
              </Button>
            )}
            <Button
              testID="terminal-toggle"
              variant={terminalMode ? "danger" : "outline"}
              disabled={blocked || !!editing}
              accessibilityLabel={
                terminalMode
                  ? t("ui-chat.composer.terminalOffA11y")
                  : t("ui-chat.composer.terminalOnA11y")
              }
              onPress={() => {
                setTerminalMode(!terminalMode);
                setPreview(false);
                setTimeout(() => composer.current?.focus(), 0);
              }}
            >
              {terminalMode
                ? t("ui-chat.composer.terminalOn")
                : t("ui-chat.composer.terminalOff")}
            </Button>
            {busyHint ? (
              // R #7: why 立即追加 is not offered, and the 插队 shortcut.
              <Text
                testID="steer-hint"
                numberOfLines={compact ? 1 : 2}
                style={{ flex: 1, fontSize: 10, color: C.muted }}
              >
                {busyHint}
              </Text>
            ) : compact ? (
              <View style={{ flex: 1 }} />
            ) : (
              <Text
                style={{
                  flex: 1,
                  fontSize: 10,
                  color: terminalMode ? TERMINAL.faint : C.faint,
                }}
              >
                {terminalMode
                  ? t("ui-chat.composer.terminalStays")
                  : t("ui-chat.composer.fileLimit")}
              </Text>
            )}
            {canSteer(steerState) ? (
              <Button
                testID="steer-message"
                busy={sending}
                variant="soft"
                onPress={() => void send(true)}
              >
                {t("ui-chat.composer.steer")}
              </Button>
            ) : null}
            {busy ? (
              <Button
                variant="danger"
                onPress={() =>
                  void client
                    .cancel(sessionId)
                    .catch((e) => setError(e.message))
                }
              >
                {t("ui-chat.composer.stop")}
              </Button>
            ) : null}
            {terminalMode ? (
              <Button
                testID="run-command"
                variant="danger"
                busy={sending}
                disabled={blocked || residentPaused || !text.trim()}
                onPress={() => void runCommand()}
              >
                {t("ui-chat.composer.run")}
              </Button>
            ) : (
              <Button
                testID="send-message"
                busy={sending}
                disabled={
                  blocked ||
                  residentPaused ||
                  (!text.trim() && !attachments.length && !finished.length)
                }
                onPress={() => void send()}
              >
                {editing
                  ? t("ui-chat.composer.rewindResend")
                  : busy
                    ? t("ui-chat.composer.queue")
                    : t("ui-chat.composer.send")}
              </Button>
            )}
          </View>
        </View>
        {copy.footer ? (
          <Text style={{ fontSize: 10, color: C.faint, textAlign: "center" }}>
            {copy.footer}
          </Text>
        ) : null}
      </View>
      {panel && snap ? (
        <CommandCenter
          client={client}
          snapshot={snap}
          initial={panel}
          onClose={() => setPanel(null)}
          onNavigate={navigate}
          onInsert={setText}
          onTerminal={() =>
            adapters.openTerminal
              ? adapters.openTerminal({ sessionId, client })
              : setNativeTerminal(true)
          }
        />
      ) : null}
      {nativeTerminal ? (
        <NativeTerminal
          client={client}
          sessionId={sessionId}
          onClose={() => setNativeTerminal(false)}
        />
      ) : null}
    </KeyboardAvoidingView>
  );
}
