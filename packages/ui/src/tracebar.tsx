import { Text } from "./primitives";
import React, { useEffect, useRef, useState } from "react";
import {
  View,
  Pressable,
  Animated,
  AccessibilityInfo,
  Easing,
  Platform,
  ScrollView,
  useWindowDimensions,
} from "react-native";
import type {
  Item,
  LiveActivity,
  LiveState,
  LiveTimer,
  Session,
} from "@daisy-ai/contracts";
import {
  STANDARD_TIER,
  isSchedulerItem,
  tierName,
} from "@daisy-ai/contracts";
import { useDaisyTheme } from "./theme";
import { useT } from "./i18n";
import { useDaisyTime } from "./host";
import {
  agoText,
  backgroundKind,
  backgroundSource,
  backgroundStop,
  elapsedText,
  daisyOfflineNote,
  hasOutput,
  offlineEffect,
} from "./present";
const NATIVE_DRIVER = Platform.OS !== "web";
/**
 * Five small dots, a wave running through them while the Agent works
 *: the trace bar's whole graphic. Still and faint when idle.
 */
export function TraceDots({
  active,
  color,
}: {
  active: boolean;
  color?: string;
}) {
  const { C } = useDaisyTheme();
  const value = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    let loop: Animated.CompositeAnimation | undefined,
      closed = false;
    const update = (reduced: boolean) => {
      loop?.stop();
      value.setValue(0);
      if (active && !reduced && !closed) {
        loop = Animated.loop(
          Animated.timing(value, {
            toValue: 1,
            duration: 1100,
            easing: Easing.linear,
            useNativeDriver: NATIVE_DRIVER,
          }),
        );
        loop.start();
      }
    };
    void AccessibilityInfo.isReduceMotionEnabled().then(update);
    const sub = AccessibilityInfo.addEventListener(
      "reduceMotionChanged",
      update,
    );
    return () => {
      closed = true;
      loop?.stop();
      sub.remove();
    };
  }, [active, value]);
  const dot = color || (active ? C.accent : C.lineStrong);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 3 }}>
      {[0, 1, 2, 3, 4].map((i) => (
        <Animated.View
          key={i}
          style={{
            width: 4,
            height: 4,
            borderRadius: 2,
            backgroundColor: dot,
            opacity: active
              ? value.interpolate({
                  inputRange: [-1, i * 0.2, i * 0.2 + 0.1, i * 0.2 + 0.2, 2],
                  outputRange: [0.25, 0.25, 1, 0.25, 0.25],
                  extrapolate: "clamp",
                })
              : 0.9,
          }}
        />
      ))}
    </View>
  );
}
/** Re-render every `ms` while `on` (elapsed times on the bar). */
export function useTicker(on: boolean, ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [on, ms]);
  return now;
}
/**
 * Online / offline: is a real Agent process behind this
 * conversation. Next to it a 「下线」 button whenever it is online. The badge
 * opens a panel: since when, and everything running in the background
 * (commands, Monitor, subagents, timers) — each opens to show what it is
 * doing: its command or prompt, progress, the end of its output.
 */
export function LiveBadge({
  live,
  scheduler = [],
  onOffline,
  loadActivity,
  agent,
  onStop,
}: {
  live: LiveState | undefined;
  /**
   * Daisy's timers / background items (session.schedulerPending):
   * kept by the control plane, so listed offline too and not ended by 下线.
   */
  scheduler?: LiveTimer[];
  onOffline: () => Promise<unknown>;
  /** Background tasks right now; polled while the panel is open. */
  loadActivity?: () => Promise<{ items: LiveActivity[] }>;
  /** the session's agent (labels the Agent's own items). */
  agent?: string;
  /**
   * 「停止」 one item (`client.stopBackground`); absent = no
   * per-item stop (an older host).
   */
  onStop?: (taskId: string) => Promise<unknown>;
}) {
  const { C, s, rad, sp } = useDaisyTheme();
  const t = useT();
  const when = useDaisyTime();
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [expanded, setExpanded] = useState<string | null>(null),
    [activity, setActivity] = useState<Record<string, LiveActivity>>({});
  const online = !!live?.online,
    native = online ? live?.pending || [] : [],
    pending = [...native, ...scheduler];
  const now = useTicker(open);
  const { width: winWidth } = useWindowDimensions();
  const hasTasks = pending.some((p) => p.kind === "task");
  useEffect(() => {
    if (!open || !online || !hasTasks || !loadActivity) return;
    let closed = false;
    const read = () =>
      void loadActivity()
        .then((r) => {
          if (!closed)
            setActivity(Object.fromEntries(r.items.map((a) => [a.id, a])));
        })
        .catch(() => {});
    read();
    const timer = setInterval(read, 3000);
    return () => {
      closed = true;
      clearInterval(timer);
    };
  }, [open, online, hasTasks, loadActivity]);
  const offline = () => {
    setBusy(true);
    setError("");
    void onOffline()
      .then(() => setOpen(false))
      .catch((e) => setError(e.message))
      .finally(() => setBusy(false));
  };
  const label = online
    ? pending.length
      ? t("ui-trace.live.onlineBackground", { n: pending.length })
      : t("ui-trace.live.online")
    : scheduler.length
      ? t("ui-trace.live.offlineBackground", { n: scheduler.length })
      : t("ui-trace.live.offline");
  return (
    <View style={[s.row, { position: "relative", gap: 6 }]}>
      <Pressable
        testID="live-badge"
        accessibilityRole="button"
        accessibilityLabel={
          online
            ? pending.length
              ? t("ui-trace.live.a11yOnlineBackground", { n: pending.length })
              : t("ui-trace.live.a11yOnline")
            : t("ui-trace.live.a11yOffline")
        }
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(!open)}
        style={[s.row, { gap: 5, paddingVertical: 2, paddingHorizontal: 2 }]}
      >
        <View
          style={{
            width: 7,
            height: 7,
            borderRadius: 4,
            backgroundColor: online ? C.green : "transparent",
            borderWidth: online ? 0 : 1.5,
            borderColor: C.faint,
          }}
        />
        <Text
          style={{ fontSize: 11, color: online ? C.green : C.muted }}
          numberOfLines={1}
        >
          {live?.stopping ? t("ui-trace.live.goingOffline") : label}
        </Text>
      </Pressable>
      {online && !live?.stopping ? (
        <Pressable
          testID="offline-button"
          accessibilityRole="button"
          accessibilityLabel={
            pending.length
              ? t("ui-trace.live.offlineButtonA11y")
              : t("ui-trace.live.offlineButton")
          }
          disabled={busy}
          // Something in the background: show first what ends with it (the
          // Agent's own) and what does not (Daisy's, each with its own
          // 「停止」 / 「取消」; C1-c — 下线 alone left a Daisy command running
          // with no word about it).
          onPress={() => (pending.length ? setOpen(true) : offline())}
          style={{
            borderWidth: 1,
            borderColor: C.line,
            borderRadius: rad(6),
            paddingHorizontal: 6,
            paddingVertical: 1,
          }}
        >
          <Text style={{ fontSize: 11, color: C.muted }}>
            {busy ? t("ui-trace.live.goingOffline") : t("ui-trace.live.offlineButton")}
          </Text>
        </Pressable>
      ) : null}
      {open ? (
        <View
          testID="live-panel"
          style={{
            position: "absolute",
            bottom: 26,
            right: 0,
            // Absolute inside the small badge row: size from the window.
            width: Math.min(380, winWidth - 24),
            zIndex: 20,
            backgroundColor: C.paper,
            borderWidth: 1,
            borderColor: C.line,
            borderRadius: rad(10),
            padding: sp(12),
            gap: 7,
            ...(Platform.OS === "web"
              ? ({ boxShadow: "0 8px 24px rgba(16,35,41,0.14)" } as any)
              : { elevation: 6 }),
          }}
        >
          {online ? (
            <>
              <View style={[s.row, { justifyContent: "space-between" }]}>
                <Text style={{ fontSize: 13, fontWeight: "600", color: C.ink }}>
                  {t("ui-trace.live.panelOnline")}
                </Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t("ui-trace.close")}
                  onPress={() => setOpen(false)}
                  hitSlop={8}
                >
                  <Text style={{ fontSize: 13, color: C.faint }}>×</Text>
                </Pressable>
              </View>
              <Text style={{ fontSize: 11, color: C.muted }}>
                {live?.since ? t("ui-trace.live.running", { elapsed: elapsedText(now - live.since) }) : ""}
                {live?.lastActivity
                  ? t("ui-trace.live.lastActivity", { ago: agoText(now - live.lastActivity) })
                  : ""}
              </Text>
              {pending.length ? (
                <View style={{ gap: 4 }}>
                  <Text style={{ fontSize: 11, color: C.muted }}>
                    {t("ui-trace.live.backgroundList", { n: pending.length })}
                  </Text>
                  {pending.map((p) => (
                    <BackgroundItem
                      key={p.id}
                      item={p}
                      agent={agent}
                      onStop={onStop}
                      activity={activity[p.id]}
                      now={now}
                      open={expanded === p.id}
                      onToggle={() =>
                        setExpanded(expanded === p.id ? null : p.id)
                      }
                      at={p.at ? when.time(p.at) : ""}
                    />
                  ))}
                </View>
              ) : (
                <Text style={{ fontSize: 12, color: C.muted }}>
                  {t("ui-trace.live.backgroundNone")}
                </Text>
              )}
              <Text style={{ fontSize: 11, color: C.faint }}>
                {t("ui-trace.live.onlineNote")}
                {scheduler.length ? daisyOfflineNote(scheduler) : ""}
              </Text>
              {error ? (
                <Text style={{ fontSize: 11, color: C.red }}>{error}</Text>
              ) : null}
              {live?.stopping ? null : (
                <Pressable
                  testID="go-offline"
                  accessibilityRole="button"
                  disabled={busy}
                  onPress={offline}
                  style={{
                    alignSelf: "flex-start",
                    borderWidth: 1,
                    borderColor: C.line,
                    borderRadius: rad(7),
                    paddingHorizontal: 10,
                    paddingVertical: 4,
                  }}
                >
                  <Text style={{ fontSize: 12, color: C.ink }}>
                    {busy ? t("ui-trace.live.goingOffline") : t("ui-trace.live.offlineButton")}
                    {offlineEffect(native.length, scheduler)}
                  </Text>
                </Pressable>
              )}
            </>
          ) : (
            <>
              <Text style={{ fontSize: 13, fontWeight: "600", color: C.ink }}>
                {t("ui-trace.live.panelOffline")}
              </Text>
              {live?.reason ? (
                <Text style={{ fontSize: 12, color: C.muted }}>
                  {live.reason}
                </Text>
              ) : null}
              <Text style={{ fontSize: 11, color: C.faint }}>
                {t("ui-trace.live.offlineNote")}
              </Text>
              {scheduler.length ? (
                <View style={{ gap: 4 }}>
                  <Text style={{ fontSize: 11, color: C.muted }}>
                    {t("ui-trace.live.schedulerList", { n: scheduler.length })}
                  </Text>
                  {scheduler.map((p) => (
                    <BackgroundItem
                      key={p.id}
                      item={p}
                      agent={agent}
                      onStop={onStop}
                      activity={undefined}
                      now={now}
                      open={expanded === p.id}
                      onToggle={() =>
                        setExpanded(expanded === p.id ? null : p.id)
                      }
                      at={p.at ? when.time(p.at) : ""}
                    />
                  ))}
                </View>
              ) : null}
            </>
          )}
        </View>
      ) : null}
    </View>
  );
}
/** One thing running in the background; opens to what it is doing. */
function BackgroundItem({
  item,
  agent,
  onStop,
  activity,
  now,
  open,
  onToggle,
  at,
}: {
  item: LiveTimer;
  agent?: string;
  onStop?: (taskId: string) => Promise<unknown>;
  activity: LiveActivity | undefined;
  now: number;
  open: boolean;
  onToggle: () => void;
  at: string;
}) {
  const { C, rad, font } = useDaisyTheme();
  const t = useT();
  const { icon, kind } = backgroundKind(item);
  // whose it is, and its own 「停止」 / 「取消」.
  const source = backgroundSource(item, agent);
  const stop = onStop ? backgroundStop(item) : null;
  const [asked, setAsked] = useState(false),
    [stopError, setStopError] = useState("");
  const stopNow = () => {
    setAsked(true);
    setStopError("");
    void onStop!(item.id).catch((e: any) => {
      setAsked(false);
      setStopError(e?.message || t("ui-trace.bg.stopFailed"));
    });
  };
  const mono = { fontFamily: font.mono, fontSize: 11, color: C.ink };
  const facts = [
    item.since ? t("ui-trace.bg.running", { elapsed: elapsedText(now - item.since) }) : "",
    at ? (item.kind === "task" ? at : t("ui-trace.bg.at", { at })) : "",
    item.recurring ? t("ui-trace.bg.recurring") : "",
    activity?.toolUses ? t("ui-trace.bg.toolUses", { n: activity.toolUses }) : "",
    activity?.tokens ? t("ui-trace.bg.tokens", { n: Math.round(activity.tokens / 1000) }) : "",
  ].filter(Boolean);
  return (
    <View testID="live-pending">
      <View style={{ flexDirection: "row", gap: 6, alignItems: "flex-start" }}>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          onPress={onToggle}
          style={{ flex: 1, flexDirection: "row", gap: 6, paddingVertical: 2 }}
        >
          <Text style={{ fontSize: 12, color: C.faint }}>
            {open ? "▾" : "▸"}
          </Text>
          <Text
            style={{ flex: 1, fontSize: 12, color: C.ink }}
            numberOfLines={open ? undefined : 2}
          >
            {icon}{" "}
            {source
              ? t("ui-trace.bg.itemWithSource", { kind, source, label: item.label })
              : t("ui-trace.bg.item", { kind, label: item.label })}
            {facts.length ? (
              <Text style={{ color: C.muted }}> · {facts.join(" · ")}</Text>
            ) : null}
          </Text>
        </Pressable>
        {stop ? (
          <Pressable
            testID="live-pending-stop"
            accessibilityRole="button"
            accessibilityLabel={t("ui-trace.bg.stopA11y", { action: stop.label, label: item.label })}
            disabled={stop.busy || asked}
            onPress={stopNow}
            style={{
              borderWidth: 1,
              borderColor: C.line,
              borderRadius: rad(6),
              paddingHorizontal: 6,
              paddingVertical: 1,
              marginTop: 1,
            }}
          >
            <Text style={{ fontSize: 11, color: C.muted }}>
              {stop.busy || (asked && !isSchedulerItem(item))
                ? t("ui-trace.bg.stopping")
                : stop.label}
            </Text>
          </Pressable>
        ) : onStop && item.kind === "task" && !isSchedulerItem(item) ? (
          // The Agent cannot stop this one alone: say what can (C1-c).
          <Text
            testID="live-pending-no-stop"
            style={{ fontSize: 11, color: C.faint, marginTop: 2 }}
          >
            {t("ui-trace.bg.endsOffline")}
          </Text>
        ) : null}
      </View>
      {stopError ? (
        <Text style={{ fontSize: 11, color: C.red, marginLeft: 16 }}>
          {stopError}
        </Text>
      ) : null}
      {open ? (
        <View
          testID="live-pending-detail"
          style={{ marginLeft: 16, marginTop: 2, gap: 4 }}
        >
          {item.command ? (
            <Text style={mono} selectable>
              $ {item.command}
            </Text>
          ) : null}
          {item.subagent ? (
            <Text style={{ fontSize: 11, color: C.muted }}>
              {t("ui-trace.bg.type", { type: item.subagent })}
            </Text>
          ) : null}
          {item.prompt ? (
            <Text style={{ fontSize: 11, color: C.muted }} selectable>
              {t("ui-trace.bg.task", { task: item.prompt })}
            </Text>
          ) : null}
          {activity?.summary || activity?.lastTool ? (
            <Text style={{ fontSize: 11, color: C.ink }}>
              {activity.summary ? t("ui-trace.bg.progress", { summary: activity.summary }) : ""}
              {activity.summary && activity.lastTool ? " · " : ""}
              {activity.lastTool ? t("ui-trace.bg.lastTool", { tool: activity.lastTool }) : ""}
            </Text>
          ) : null}
          {hasOutput(item) ? (
            activity?.output ? (
              <ScrollView
                testID="live-output"
                style={{
                  maxHeight: 180,
                  backgroundColor: C.bg,
                  borderRadius: rad(6),
                  padding: 6,
                }}
              >
                <Text style={mono} selectable>
                  {activity.outputBytes &&
                  activity.outputBytes > activity.output.length
                    ? t("ui-trace.bg.outputTail", { kb: Math.ceil(activity.outputBytes / 1024) }) + "\n"
                    : ""}
                  {activity.output}
                </Text>
              </ScrollView>
            ) : (
              <Text style={{ fontSize: 11, color: C.faint }}>
                {activity ? t("ui-trace.bg.noOutput") : t("ui-trace.bg.readingOutput")}
              </Text>
            )
          ) : null}
          {item.kind !== "task" ? (
            <Text style={{ fontSize: 11, color: C.faint }}>
              {item.kind === "wakeup"
                ? t("ui-trace.bg.wakeupNote")
                : t("ui-trace.bg.cronNote")}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
/**
 * Model · effort of this conversation: what the Agent reported it
 * runs with, or the choice waiting for the next turn. Opens the model panel.
 */
export function ModelChip({
  session,
  onPress,
}: {
  session: Session;
  onPress: () => void;
}) {
  const { C, rad } = useDaisyTheme();
  const t = useT();
  const want = session.settings || {},
    got = session.runtime || ({} as NonNullable<Session["runtime"]>);
  const model = want.model || got.model || t("ui-trace.model.default"),
    effort = want.reasoningEffort || got.effort || "",
    // Codex Fast (any tier but standard) shows as its name.
    tier = want.serviceTier || got.serviceTier || "",
    fast = tier && tier !== STANDARD_TIER ? tierName(tier, undefined, t) : "",
    waiting =
      (!!want.model && !!got.model && want.model !== got.model) ||
      (!!want.reasoningEffort &&
        !!got.effort &&
        want.reasoningEffort !== got.effort) ||
      (!!want.serviceTier &&
        !!got.serviceTier &&
        want.serviceTier !== got.serviceTier);
  const text =
    (model.length > 26 ? model.slice(0, 25) + "…" : model) +
    (effort
      ? ` · ${t.has(`ui-present.effort.${effort}`) ? t.dynamic(`ui-present.effort.${effort}`) : effort}`
      : "") +
    (fast ? ` · ${fast}` : "");
  return (
    <Pressable
      testID="model-chip"
      accessibilityRole="button"
      accessibilityLabel={t("ui-trace.model.a11y", {
        model,
        effort: effort ? t("ui-trace.model.a11yEffort", { effort }) : "",
        fast: fast ? t("ui-trace.model.a11yFast", { fast }) : "",
      })}
      onPress={onPress}
      style={{
        borderWidth: 1,
        borderColor: C.line,
        borderRadius: rad(6),
        paddingHorizontal: 7,
        paddingVertical: 1,
        // The status line's only elastic item: at phone width the chip
        // shrinks (its text ellipsizes) instead of pushing the context ring
        // past the edge (e2e-codex-effort at 390 px).
        flexShrink: 1,
        minWidth: 0,
      }}
    >
      <Text style={{ fontSize: 11, color: C.muted }} numberOfLines={1}>
        {text}
        {waiting ? t("ui-trace.model.nextTurn") : ""}
      </Text>
    </Pressable>
  );
}
/**
 * Head of a turn the Agent started by itself. `waiting`: its wake
 * job is still queued behind the running turn — not delivered yet, so it
 * reads 「等待发送」 (muted), as a queued user message does; once the job
 * starts it is 「AI 自己继续」. Removed from the queue (status `cancelled`):
 * 「已移除」, muted — it never reached the AI.
 */
export function WakeMarker({
  item,
  waiting = false,
}: {
  item: Item;
  waiting?: boolean;
}) {
  const { C, rad, sp } = useDaisyTheme();
  const t = useT();
  const when = useDaisyTime();
  // The wake's text is the server's (any language, older rows too): its
  // timer heads 「【Daisy 定时器到点】」 / "[Daisy timer due]" / "[Daisy
  // scheduled task fired]", or an older bare 「定时 …」.
  const timer = /^(?:[【[][^\s\]】]+ )?(定时|timer|scheduled)/i.test(item.text);
  const removed = item.status === "cancelled",
    quiet = waiting || removed;
  const color = quiet ? C.muted : C.accent;
  return (
    <View
      testID="wake-marker"
      accessibilityLabel={
        waiting ? t("ui-trace.wake.waitingA11y", { text: item.text }) : undefined
      }
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        marginTop: 18,
        marginBottom: 4,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
          backgroundColor: C.soft,
          borderRadius: rad(12),
          paddingHorizontal: sp(10),
          paddingVertical: 3,
          maxWidth: "90%",
        }}
      >
        <Text
          testID={
            waiting
              ? "wake-marker-waiting"
              : removed
                ? "wake-marker-removed"
                : undefined
          }
          style={{ fontSize: 12, color }}
        >
          {waiting ? "⏳" : removed ? "✕" : timer ? "◷" : "↩"}
        </Text>
        <Text
          style={{
            fontSize: 12,
            color,
            fontWeight: quiet ? "400" : "600",
          }}
          numberOfLines={2}
        >
          {t("ui-trace.wake.line", {
            state: waiting
              ? t("ui-trace.wake.waiting")
              : removed
                ? t("ui-trace.wake.removed")
                : t("ui-trace.wake.continues"),
            text: item.text,
          })}
        </Text>
      </View>
      <Text style={{ fontSize: 10, color: C.faint }}>
        {when.time(item.createdAt)}
      </Text>
    </View>
  );
}
/** 「⟲ 已压缩上下文：340K → 9.9K」. */
export function CompactNotice({ item }: { item: Item }) {
  const { C } = useDaisyTheme();
  const when = useDaisyTime();
  return (
    <View
      testID="compact-notice"
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        marginVertical: 10,
      }}
    >
      <View style={{ flex: 1, height: 1, backgroundColor: C.line }} />
      <Text style={{ fontSize: 12, color: C.muted }}>⟲ {item.text}</Text>
      <Text style={{ fontSize: 10, color: C.faint }}>
        {when.time(item.createdAt)}
      </Text>
      <View style={{ flex: 1, height: 1, backgroundColor: C.line }} />
    </View>
  );
}
