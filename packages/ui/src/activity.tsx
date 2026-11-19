import { Text } from "./primitives";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  View,
  ScrollView,
  Pressable,
  Animated,
  AccessibilityInfo,
  Easing,
  Platform,
} from "react-native";
import type { Approval, Item, Translate } from "@daisy-ai/contracts";
import { useT } from "./i18n";
import { Badge } from "./primitives";
import { useDaisyTheme, withAlpha } from "./theme";
import { useDaisyCopy } from "./host";
import { commandOf, fillCopy as fill, isStep, turnActions } from "./present";
import Markdown from "./markdown";
/** The native driver does not exist on web (react-native-web warns each mount). */
const NATIVE_DRIVER = Platform.OS !== "web";
export function Pulse({
  active = true,
  color,
}: {
  active?: boolean;
  color?: string;
}) {
  const { C } = useDaisyTheme();
  color ??= C.accent;
  const value = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    let loop: Animated.CompositeAnimation | undefined,
      closed = false;
    const update = (reduced: boolean) => {
      loop?.stop();
      value.setValue(1);
      if (active && !reduced && !closed) {
        loop = Animated.loop(
          Animated.sequence([
            Animated.timing(value, {
              toValue: 0.3,
              duration: 750,
              useNativeDriver: NATIVE_DRIVER,
            }),
            Animated.timing(value, {
              toValue: 1,
              duration: 750,
              useNativeDriver: NATIVE_DRIVER,
            }),
          ]),
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
  return (
    <Animated.View
      style={{
        width: 8,
        height: 8,
        borderRadius: 4,
        backgroundColor: color,
        opacity: value,
      }}
    />
  );
}
export function Reveal(props: React.ComponentProps<typeof Animated.View>) {
  const value = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    let closed = false;
    void AccessibilityInfo.isReduceMotionEnabled().then((reduced) => {
      if (closed) return;
      if (reduced) value.setValue(1);
      else
        Animated.timing(value, {
          toValue: 1,
          duration: 260,
          useNativeDriver: NATIVE_DRIVER,
        }).start();
    });
    return () => {
      closed = true;
      value.stopAnimation();
    };
  }, [value]);
  return (
    <Animated.View
      {...props}
      style={[
        props.style,
        {
          opacity: value,
          transform: [
            {
              translateY: value.interpolate({
                inputRange: [0, 1],
                outputRange: [5, 0],
              }),
            },
          ],
        },
      ]}
    />
  );
}
// Every symbol shares a fixed 44px row. Labels and animation never move its axis.
const SYMBOL_ROW = 44;
function useReducedMotion() {
  const [reduced, setReduced] = useState<boolean | null>(null);
  useEffect(() => {
    let closed = false,
      changed = false;
    const sub = AccessibilityInfo.addEventListener(
      "reduceMotionChanged",
      (value) => {
        changed = true;
        if (!closed) setReduced(value);
      },
    );
    void AccessibilityInfo.isReduceMotionEnabled().then(
      (value) => {
        if (!closed && !changed) setReduced(value);
      },
      () => {
        if (!closed && !changed) setReduced(true);
      },
    );
    return () => {
      closed = true;
      sub.remove();
    };
  }, []);
  return reduced;
}
// One cursor owns the entire sweep: a connector must finish before the next
// point is reached. Appending items never restarts already traversed segments.
function useTrackCursor(
  items: Item[],
  active: boolean,
  reduced: boolean | null,
) {
  const [cursor, setCursor] = useState(() =>
    active ? 0 : Math.max(0, items.length - 1),
  );
  const firstId = items[0]?.id;
  const identity = useRef(firstId);
  useEffect(() => {
    if (identity.current !== firstId) {
      identity.current = firstId;
      setCursor(active && !reduced ? 0 : Math.max(0, items.length - 1));
    } else if (reduced) {
      setCursor(Math.max(0, items.length - 1));
    } else {
      setCursor((value) => Math.min(value, Math.max(0, items.length - 1)));
    }
  }, [firstId, items.length, active, reduced]);
  // Once the turn is over every step has been reached: let an in-flight
  // sweep finish, then fill the rest so 「N / N 已完成」 matches solid dots
  // (review r2 N8; a collapsed or late-mounted track never completes its
  // connector animations).
  useEffect(() => {
    if (active || !items.length) return;
    const timer = setTimeout(
      () => setCursor((value) => Math.max(value, items.length - 1)),
      1200,
    );
    return () => clearTimeout(timer);
  }, [active, items.length]);
  const arrive = useCallback((index: number) => {
    setCursor((value) => Math.max(value, index + 1));
  }, []);
  return { cursor, arrive };
}
function TrackConnector({
  width,
  inset,
  color,
  reduced,
  phase,
  index,
  onArrive,
}: {
  width: number;
  inset: number;
  color: string;
  reduced: boolean | null;
  phase: "waiting" | "flowing" | "done";
  index: number;
  onArrive: (index: number) => void;
}) {
  const progress = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (reduced === null) return;
    if (reduced || phase === "done") {
      progress.setValue(1);
      return;
    }
    progress.setValue(0);
    if (phase === "waiting") return;
    const animation = Animated.sequence([
      // Let the current point bounce before flowing to the following point.
      Animated.delay(280),
      Animated.timing(progress, {
        toValue: 1,
        duration: 340,
        easing: Easing.inOut(Easing.cubic),
        useNativeDriver: NATIVE_DRIVER,
      }),
    ]);
    animation.start(({ finished }) => {
      if (finished) onArrive(index);
    });
    return () => animation.stop();
  }, [progress, reduced, phase, index, onArrive]);
  return (
    <View
      pointerEvents="none"
      testID="activity-connector"
      style={{
        position: "absolute",
        top: (SYMBOL_ROW - 1) / 2,
        left: width / 2 + inset,
        width: width - inset * 2,
        height: 1,
        overflow: "hidden",
      }}
    >
      <Animated.View
        style={{
          width: "100%",
          height: 1,
          backgroundColor: color,
          transform: [
            {
              translateX: progress.interpolate({
                inputRange: [0, 1],
                outputRange: [-(width - inset * 2), 0],
              }),
            },
          ],
        }}
      />
    </View>
  );
}
function TrackMark({
  expanded,
  running,
  selected,
  color,
  symbol,
  reduced,
  reached,
}: {
  expanded: boolean;
  running: boolean;
  selected: boolean;
  color: string;
  symbol: string;
  reduced: boolean | null;
  reached: boolean;
}) {
  const { C } = useDaisyTheme();
  const entry = useRef(new Animated.Value(0)).current;
  const breath = useRef(new Animated.Value(0)).current;
  const ripple = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (reduced === null) return;
    if (reduced) {
      entry.setValue(1);
      return;
    }
    entry.setValue(0);
    if (!reached) return;
    const animation = Animated.timing(entry, {
      toValue: 1,
      duration: 280,
      easing: Easing.linear,
      useNativeDriver: NATIVE_DRIVER,
    });
    animation.start();
    return () => animation.stop();
  }, [entry, reduced, reached]);
  useEffect(() => {
    breath.setValue(0);
    ripple.setValue(0);
    if (!running || !reached || reduced !== false) return;
    const breathing = Animated.loop(
      Animated.sequence([
        Animated.timing(breath, {
          toValue: 1,
          duration: 1000,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: NATIVE_DRIVER,
        }),
        Animated.timing(breath, {
          toValue: 0,
          duration: 1000,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: NATIVE_DRIVER,
        }),
      ]),
    );
    const rippling = Animated.loop(
      Animated.sequence([
        Animated.timing(ripple, {
          toValue: 1,
          duration: 1800,
          easing: Easing.out(Easing.quad),
          useNativeDriver: NATIVE_DRIVER,
        }),
        Animated.delay(250),
      ]),
    );
    breathing.start();
    rippling.start();
    return () => {
      breathing.stop();
      rippling.stop();
    };
  }, [running, reached, reduced, breath, ripple]);
  const size = expanded ? 30 : running ? 9 : 7;
  const ringSize = expanded ? 32 : 13;
  return (
    <View
      pointerEvents="none"
      style={{
        height: SYMBOL_ROW,
        width: "100%",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Animated.View
        style={{
          width: size,
          height: size,
          alignItems: "center",
          justifyContent: "center",
          opacity: entry.interpolate({
            inputRange: [0, 0.3, 1],
            outputRange: [0.4, 1, 1],
          }),
          transform: [
            {
              scale: entry.interpolate({
                inputRange: [0, 0.42, 0.72, 1],
                outputRange: [0.8, expanded ? 1.16 : 1.6, 0.94, 1],
              }),
            },
          ],
        }}
      >
        {running ? (
          <Animated.View
            testID="activity-halo"
            style={{
              position: "absolute",
              width: ringSize,
              height: ringSize,
              borderRadius: ringSize / 2,
              borderWidth: 1,
              borderColor: withAlpha(color, "55"),
              backgroundColor: withAlpha(color, "0c"),
              opacity: breath.interpolate({
                inputRange: [0, 1],
                outputRange: [0.55, 1],
              }),
              transform: [
                {
                  scale: breath.interpolate({
                    inputRange: [0, 1],
                    outputRange: [1, 1.18],
                  }),
                },
              ],
            }}
          />
        ) : null}
        {running && reached && reduced === false ? (
          <Animated.View
            testID="activity-ripple"
            style={{
              position: "absolute",
              width: ringSize,
              height: ringSize,
              borderRadius: ringSize / 2,
              borderWidth: 1,
              borderColor: color,
              opacity: ripple.interpolate({
                inputRange: [0, 0.15, 1],
                outputRange: [0, 0.28, 0],
              }),
              transform: [
                {
                  scale: ripple.interpolate({
                    inputRange: [0, 1],
                    outputRange: [0.8, expanded ? 1.35 : 1.9],
                  }),
                },
              ],
            }}
          />
        ) : null}
        <Animated.View
          testID="activity-dot"
          style={{
            width: size,
            height: size,
            borderRadius: size / 2,
            backgroundColor:
              !expanded || selected ? color : withAlpha(color, "16"),
            borderWidth: 1,
            borderColor: selected ? color : withAlpha(color, "45"),
            alignItems: "center",
            justifyContent: "center",
            opacity: breath.interpolate({
              inputRange: [0, 1],
              outputRange: [1, 0.78],
            }),
            transform: [
              {
                scale: breath.interpolate({
                  inputRange: [0, 1],
                  outputRange: [1, expanded ? 1.035 : 1.12],
                }),
              },
            ],
          }}
        >
          {expanded ? (
            <Text
              style={{
                fontSize: 13,
                fontWeight: "700",
                color: selected ? C.onAccent : color,
              }}
            >
              {symbol}
            </Text>
          ) : null}
        </Animated.View>
      </Animated.View>
    </View>
  );
}
/** Native item names people read in their own words (`ui-chat.tool.<name>`; others as they are). */
const TOOL_NAMES = new Set([
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "webSearch",
  "contextCompaction",
  "dynamicToolCall",
  "imageView",
  "imageGeneration",
  "ScheduleWakeup",
  "CronCreate",
  "CronDelete",
  "Monitor",
]);
const toolName = (t: Translate, name: string) =>
  TOOL_NAMES.has(name) ? t.dynamic(`ui-chat.tool.${name}`) : name;
export function ActivityTrack({
  items,
  active,
  terminal,
  compact = false,
  approvals = [],
  initialExpanded = false,
}: {
  items: Item[];
  active: boolean;
  terminal?: string;
  /**
   * DaisyChat `chrome="compact"`: the turn shows as one summary line
   * (「✓ 运行了 pwd（允许本次）▸」) that expands to the full track.
   */
  compact?: boolean;
  /** Tool authorizations decided in this turn, merged into the compact summary. */
  approvals?: Approval[];
  /** Open with the large step circles (the trace bar's expanded view). */
  initialExpanded?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null),
    [raw, setRaw] = useState(false),
    [expanded, setExpanded] = useState(initialExpanded),
    [following, setFollowing] = useState(true);
  const reduced = useReducedMotion();
  const { C, s, rad, sp } = useDaisyTheme();
  const copy = useDaisyCopy();
  const t = useT();
  const { cursor, arrive } = useTrackCursor(items, active, reduced);
  const follow = useRef(true);
  const scroll = useRef<React.ElementRef<typeof ScrollView>>(null);
  const [viewport, setViewport] = useState(0);
  const item = items.find((x) => x.id === selected),
    // what is counted as a step (not stages / usage / hooks).
    steps = items.filter(isStep),
    done = steps.filter((x) => x.status === "complete").length;
  const plainLabel = (i: Item) => {
    if (i.kind === "thinking") return t("ui-chat.trace.thinking");
    // Runner steps (「Claude 原生会话已就绪」…) can be reworded by the host.
    const stage = /:stage:(.+)$/.exec(i.id)?.[1];
    if (stage) {
      const own =
        (i.status === "running" && copy.stageLabels[`${stage}:running`]) ||
        copy.stageLabels[stage];
      if (own) return own;
    }
    return (i.name && toolName(t, i.name)) || t("ui-chat.trace.tool");
  };
  const label = (i: Item) =>
    // Follow-up 2026-11-09: retracted with a refused answer.
    i.retracted
      ? t("ui-chat.trace.retracted", { label: plainLabel(i) })
      : plainLabel(i);
  const state = (i: Item) =>
    i.status === "complete"
      ? "complete"
      : ["error", "failed", "interrupted", "cancelled", "canceled"].includes(
            i.status || "",
          )
        ? "error"
        : active ||
            (!terminal?.match(/^(error|interrupted)$/) &&
              [
                "running",
                "streaming",
                "pending",
                "waiting",
                "inProgress",
              ].includes(i.status || ""))
          ? "running"
          : "unknown";
  // Usage records are details, not a step to report (「本轮用量」 has no
  // number to show here, review r2 N8).
  const current =
    [...items].reverse().find((i) => state(i) === "running") ||
    [...items].reverse().find((i) => i.category !== "usage");
  const followLatest = () => {
    follow.current = true;
    setFollowing(true);
    scroll.current?.scrollToEnd({ animated: true });
  };
  const tools = items.filter((i) => i.kind === "tool" && !i.category);
  const actions = turnActions(tools, approvals, copy, label);
  const runningTool =
    current && !current.category && current.kind === "tool"
      ? current
      : undefined;
  const summary = active
    ? runningTool
      ? fill(copy.traceSummaryRunning, {
          step: commandOf(runningTool.input) || label(runningTool),
        })
      : copy.traceWorking
    : actions.length
      ? actions.slice(0, 2).join(t("ui-chat.list.sep")) +
        (actions.length > 2
          ? fill(copy.traceSummaryMore, { count: actions.length })
          : "")
      : fill(copy.traceSummarySteps, { count: steps.length });
  const failed = terminal === "error",
    stopped = terminal === "interrupted";
  const summaryLine = compact ? (
    <Pressable
      testID="activity-summary"
      accessibilityRole="button"
      accessibilityState={{ expanded: open }}
      accessibilityLabel={
        open
          ? copy.traceCollapse
          : t("ui-chat.trace.summaryA11y", {
              summary,
              expand: fill(copy.traceExpand, { count: steps.length }),
            })
      }
      onPress={() => setOpen(!open)}
      style={[s.row, { gap: 6, paddingVertical: 6 }]}
    >
      {active ? (
        <Pulse active />
      ) : (
        <Text
          style={{
            fontSize: 12,
            color: failed ? C.red : stopped ? C.faint : C.accent,
          }}
        >
          {failed ? "!" : stopped ? "○" : "✓"}
        </Text>
      )}
      <Text numberOfLines={1} style={{ flex: 1, fontSize: 12, color: C.muted }}>
        {summary}
        {stopped ? ` · ${copy.traceInterrupted}` : ""}
      </Text>
      <Text style={{ fontSize: 11, color: C.faint }}>{open ? "▾" : "▸"}</Text>
    </Pressable>
  ) : null;
  if (compact && !open)
    return (
      <View testID="activity-track" style={{ marginVertical: 8 }}>
        {summaryLine}
      </View>
    );
  return (
    <View
      testID="activity-track"
      style={{
        marginVertical: 14,
        gap: 12,
        paddingVertical: 14,
        borderTopWidth: 1,
        borderBottomWidth: 1,
        borderColor: C.line,
      }}
    >
      {summaryLine}
      <View style={s.row}>
        <Pulse active={active} />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={
            expanded
              ? copy.traceCollapse
              : fill(copy.traceExpand, { count: items.length })
          }
          accessibilityState={{ expanded }}
          testID="activity-expand"
          onPress={() => setExpanded(!expanded)}
          style={{ flex: 1, paddingVertical: 6 }}
        >
          <Text style={{ color: C.ink, fontSize: 12, fontWeight: "600" }}>
            {copy.traceTitle}{" "}
            <Text style={{ color: C.muted }}>{expanded ? "↙" : "↗"}</Text>
          </Text>
        </Pressable>
        <Text style={{ fontSize: 11, color: C.muted }}>
          {fill(copy.traceProgress, { done, total: steps.length })}
          {active
            ? ` · ${copy.traceActive}`
            : terminal === "interrupted"
              ? ` · ${copy.traceInterrupted}`
              : ""}
        </Text>
      </View>
      <ScrollView
        horizontal
        testID="activity-scroll"
        ref={scroll}
        onLayout={(e) => setViewport(e.nativeEvent.layout.width)}
        showsHorizontalScrollIndicator={expanded}
        scrollEventThrottle={16}
        onScroll={(e) => {
          const { contentOffset, contentSize, layoutMeasurement } =
            e.nativeEvent;
          const atEnd =
            contentSize.width - contentOffset.x - layoutMeasurement.width < 12;
          follow.current = atEnd;
          setFollowing(atEnd);
        }}
        onScrollBeginDrag={() => {
          follow.current = false;
          setFollowing(false);
        }}
        onContentSizeChange={() => {
          if (follow.current && !selected)
            scroll.current?.scrollToEnd({ animated: false });
        }}
        contentContainerStyle={{
          paddingVertical: expanded ? 8 : 0,
          paddingRight: 12,
          alignItems: "flex-start",
        }}
      >
        {items.map((i, n) => {
          const st = state(i),
            color =
              st === "complete"
                ? C.accent
                : st === "error"
                  ? C.red
                  : st === "running"
                    ? C.blue
                    : C.muted;
          return (
            <View
              key={i.id}
              style={{ width: expanded ? 112 : 40, alignItems: "center" }}
            >
              {n < items.length - 1 ? (
                <TrackConnector
                  width={expanded ? 112 : 40}
                  inset={expanded ? 16 : 3.5}
                  color={
                    st === "complete"
                      ? C.trackDone
                      : st === "running"
                        ? C.trackRunning
                        : C.line
                  }
                  reduced={reduced}
                  index={n}
                  phase={
                    n < cursor ? "done" : n === cursor ? "flowing" : "waiting"
                  }
                  onArrive={arrive}
                />
              ) : null}
              <Pressable
                accessibilityRole="button"
                // Collapsed dots are one control (the expand button above);
                // only expanded nodes are separate tab stops.
                tabIndex={expanded ? 0 : -1}
                focusable={expanded}
                accessibilityElementsHidden={!expanded}
                accessibilityLabel={t("ui-chat.trace.nodeA11y", {
                  label: label(i),
                  state:
                    st === "complete"
                      ? t("ui-chat.trace.done")
                      : st === "running"
                        ? t("ui-chat.trace.running")
                        : st === "error"
                          ? t("ui-chat.trace.failed")
                          : t("ui-chat.trace.unconfirmed"),
                })}
                onPress={() => {
                  setSelected(selected === i.id ? null : i.id);
                  setRaw(false);
                }}
                testID="activity-node"
                style={{
                  alignItems: "center",
                  gap: 2,
                  width: expanded ? 112 : 40,
                  minHeight: 44,
                }}
              >
                <TrackMark
                  expanded={expanded}
                  reached={n <= cursor}
                  running={st === "running"}
                  selected={selected === i.id}
                  color={color}
                  reduced={reduced}
                  symbol={st === "complete" ? "✓" : st === "error" ? "!" : "·"}
                />
                {expanded ? (
                  <Text
                    numberOfLines={2}
                    style={{
                      fontSize: 11,
                      lineHeight: 16,
                      color: C.ink,
                      textAlign: "center",
                      maxWidth: 102,
                    }}
                  >
                    {label(i)}
                  </Text>
                ) : null}
              </Pressable>
            </View>
          );
        })}
        {active && expanded ? (
          <View
            style={{ width: 95, alignItems: "center", gap: 16, paddingTop: 18 }}
          >
            <Pulse />
            <Text style={{ fontSize: 10, color: C.muted }}>
              {t("ui-chat.trace.nextEvent")}
            </Text>
          </View>
        ) : null}
        {expanded && viewport ? (
          // Pad so that the scrolled-to-end position starts on a node
          // boundary: the leftmost visible label is never cut in half.
          <View
            style={{
              width: (() => {
                const content =
                  items.length * 112 + (active ? 95 : 0) + 12 - viewport;
                return content > 0 ? (112 - (content % 112)) % 112 : 0;
              })(),
            }}
          />
        ) : null}
      </ScrollView>
      <View style={s.row}>
        <Text
          testID="activity-current"
          numberOfLines={1}
          style={{ fontSize: 11, color: C.muted, flex: 1 }}
        >
          {current
            ? t("ui-chat.trace.nodeA11y", {
                label: label(current),
                state:
                  state(current) === "running"
                    ? t("ui-chat.trace.running")
                    : state(current) === "complete"
                      ? t("ui-chat.trace.done")
                      : state(current) === "error"
                        ? t("ui-chat.trace.failed")
                        : t("ui-chat.trace.awaiting"),
              })
            : t("ui-chat.trace.notStarted")}
        </Text>
        {compact ? null : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={copy.traceStart}
            onPress={() => {
              follow.current = false;
              setFollowing(false);
              scroll.current?.scrollTo({ x: 0, animated: false });
            }}
            style={{ padding: 8 }}
          >
            <Text style={{ fontSize: 11, color: C.muted }}>
              ← {copy.traceStart}
            </Text>
          </Pressable>
        )}
        {!following ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("ui-chat.trace.followLatest")}
            onPress={followLatest}
            style={{ padding: 8 }}
          >
            <Text style={{ fontSize: 11, color: C.accent }}>
              {t("ui-chat.trace.latest")}
            </Text>
          </Pressable>
        ) : null}
      </View>
      {item ? (
        <Reveal
          key={item.id}
          testID="activity-detail"
          style={{
            backgroundColor: C.surfaceAlt,
            borderRadius: rad(12),
            padding: sp(16),
            gap: sp(10),
          }}
        >
          <View style={s.row}>
            <Text style={[s.h3, { flex: 1, fontSize: 13 }]}>{label(item)}</Text>
            <Badge
              text={
                state(item) === "complete"
                  ? t("ui-chat.trace.done")
                  : state(item) === "running"
                    ? t("ui-chat.trace.running")
                    : t("ui-chat.trace.notSucceeded")
              }
              color={state(item) === "error" ? C.red : C.accent}
            />
          </View>
          {item.category === "audit" ? (
            <Text style={s.muted}>
              {String(item.id).endsWith(":launch-audit")
                ? // What Daisy appended to the system layer at this launch.
                  t("ui-chat.audit.launch")
                : t("ui-chat.audit.input")}
            </Text>
          ) : null}
          {item.parentId || item.threadId ? (
            <Text selectable style={[s.mono, { fontSize: 10, color: C.muted }]}>
              {t("ui-chat.trace.thread", {
                thread: item.threadId || t("ui-chat.trace.claudeSubtask"),
              })}
              {item.parentId
                ? t("ui-chat.trace.parent", { parent: item.parentId })
                : ""}
            </Text>
          ) : null}
          <ScrollView
            style={{
              maxHeight: 360,
            }}
            nestedScrollEnabled
          >
            {item.input !== undefined ? (
              <Text selectable style={[s.mono, { marginBottom: 12 }]}>
                {typeof item.input === "string"
                  ? item.input
                  : JSON.stringify(item.input, null, 2)}
              </Text>
            ) : null}
            <Text selectable style={s.mono}>
              {item.text ||
                (state(item) === "running"
                  ? t("ui-chat.trace.awaitingOutput")
                  : t("ui-chat.trace.noOutput"))}
            </Text>
            {raw ? (
              <Text selectable style={[s.mono, { marginTop: 15 }]}>
                {JSON.stringify(item.native, null, 2)}
              </Text>
            ) : null}
          </ScrollView>
          {item.native ? (
            <Pressable onPress={() => setRaw(!raw)}>
              <Text style={{ fontSize: 11, color: C.accent }}>
                {raw ? t("ui-chat.trace.hideNative") : t("ui-chat.trace.showNative")}
              </Text>
            </Pressable>
          ) : null}
        </Reveal>
      ) : null}
    </View>
  );
}
