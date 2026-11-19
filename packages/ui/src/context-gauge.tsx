import React, { useRef, useState } from "react";
import {
  Modal,
  Platform,
  Pressable,
  View,
  useWindowDimensions,
} from "react-native";
import type { Item, Session } from "@daisy-ai/contracts";
import { Text } from "./primitives";
import { useDaisyTheme } from "./theme";
import { useDaisyTime } from "./host";
import { contextBubble, contextGauge, type ContextGauge } from "./present";
import { useTicker } from "./tracebar";
import { useT } from "./i18n";

/**
 * The composer's context ring and its bubble (R1–R3), Web and
 * native: used / the Agent's real auto-compact trigger point (never the
 * model window), 「—」 with the reason when there is none. Tapping it opens
 * the bubble (plan, weekly / 5-hour remaining, cache hit rate, context);
 * a tap anywhere else only closes the bubble — that tap goes nowhere else
 * (Web: a transparent full-window layer that stops the event; native: a
 * transparent Modal with a full-screen Pressable).
 */
export function ContextGaugeButton({
  session,
  items,
}: {
  session: (Session & { quotaHidden?: boolean }) | null | undefined;
  items: readonly Item[];
}) {
  const { C } = useDaisyTheme();
  const t = useT();
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<{
    right: number;
    bottom: number;
  } | null>(null);
  const ring = useRef<View>(null);
  const g = contextGauge(session, items);
  const color = toneColor(g, C);
  const label = g.available
    ? t("ui-trace.gauge.label", { text: g.text, used: g.used ?? "", trigger: g.trigger ?? "" })
    : t("ui-trace.gauge.unavailable", { reason: g.reason ?? "" });
  const { width, height } = useWindowDimensions();
  const toggle = () => {
    if (open) return setOpen(false);
    // The bubble opens above the ring, right-aligned with it.
    const place = (x: number, y: number, w: number) =>
      setAnchor({ right: Math.max(8, width - x - w), bottom: height - y + 6 });
    if (ring.current?.measureInWindow) ring.current.measureInWindow(place);
    setOpen(true);
  };
  return (
    <View>
      <Pressable
        ref={ring}
        testID="context-ring"
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ expanded: open }}
        onPress={toggle}
        // Native tooltip on web.
        {...({ title: label } as any)}
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 5,
          paddingVertical: 2,
          paddingHorizontal: 2,
        }}
      >
        <Ring gauge={g} color={color} track={C.line} />
        <Text
          testID="context-ring-text"
          style={{
            fontSize: 11,
            color: g.tone === "danger" ? C.red : C.muted,
          }}
        >
          {g.text}
        </Text>
      </Pressable>
      {/* R3: a transparent layer over everything (a body-level portal on
          the Web): a tap anywhere outside the bubble only closes it. */}
      <Modal
        transparent
        visible={open}
        animationType="none"
        onRequestClose={() => setOpen(false)}
      >
        <Pressable
          testID="context-backdrop"
          accessibilityLabel={t("ui-trace.gauge.closeA11y")}
          onPress={(e: any) => {
            e?.stopPropagation?.();
            e?.preventDefault?.();
            setOpen(false);
          }}
          style={
            {
              flex: 1,
              ...(Platform.OS === "web" ? { cursor: "default" } : {}),
            } as any
          }
        >
          {/* Taps inside the bubble stay in it. */}
          <Pressable
            onPress={(e: any) => e?.stopPropagation?.()}
            style={
              {
                position: "absolute",
                right: anchor?.right ?? 12,
                bottom: anchor?.bottom ?? 120,
                ...(Platform.OS === "web" ? { cursor: "auto" } : {}),
              } as any
            }
          >
            <Bubble
              session={session}
              items={items}
              onClose={() => setOpen(false)}
            />
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}
function toneColor(g: ContextGauge, C: any) {
  return g.tone === "danger"
    ? C.red
    : g.tone === "warning"
      ? C.orange || "#d97706"
      : g.tone === "muted"
        ? C.faint
        : C.accent;
}
function Ring({
  gauge,
  color,
  track,
}: {
  gauge: ContextGauge;
  color: string;
  track: string;
}) {
  const size = 18,
    stroke = 3,
    r = (size - stroke) / 2,
    length = 2 * Math.PI * r;
  if (Platform.OS === "web")
    return React.createElement(
      "svg",
      {
        width: size,
        height: size,
        viewBox: `0 0 ${size} ${size}`,
        "data-tone": gauge.tone,
      },
      React.createElement("circle", {
        cx: size / 2,
        cy: size / 2,
        r,
        fill: "none",
        stroke: track,
        strokeWidth: stroke,
        ...(gauge.available ? {} : { strokeDasharray: "2 2" }),
      }),
      gauge.available
        ? React.createElement("circle", {
            cx: size / 2,
            cy: size / 2,
            r,
            fill: "none",
            stroke: color,
            strokeWidth: stroke,
            strokeLinecap: "round",
            strokeDasharray: `${length * gauge.fill} ${length}`,
            transform: `rotate(-90 ${size / 2} ${size / 2})`,
          })
        : null,
    );
  // Native (no SVG here): the ring's colour carries the level.
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        borderWidth: stroke,
        borderColor: gauge.available ? color : track,
        borderStyle: gauge.available ? "solid" : "dashed",
      }}
    />
  );
}
function Bubble({
  session,
  items,
  onClose,
  style,
}: {
  session: (Session & { quotaHidden?: boolean }) | null | undefined;
  items: readonly Item[];
  onClose: () => void;
  style?: any;
}) {
  const { C, rad, sp } = useDaisyTheme();
  const t = useT();
  const when = useDaisyTime();
  const now = useTicker(true, 30_000);
  const { width } = useWindowDimensions();
  const rows = contextBubble(session, items, now, (ms) =>
    new Date(ms).toDateString() === new Date(now).toDateString()
      ? when.time(ms)
      : `${when.date(ms)} ${when.time(ms)}`,
  );
  return (
    <View
      testID="context-bubble"
      accessibilityRole={"dialog" as any}
      accessibilityLabel={t("ui-trace.gauge.title")}
      style={[
        {
          width: Math.min(340, width - 24),
          backgroundColor: C.paper,
          borderWidth: 1,
          borderColor: C.line,
          borderRadius: rad(10),
          padding: sp(12),
          gap: 9,
          ...(Platform.OS === "web"
            ? ({ boxShadow: "0 8px 24px rgba(16,35,41,0.14)" } as any)
            : { elevation: 6 }),
        },
        style,
      ]}
    >
      <View
        style={{
          flexDirection: "row",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <Text style={{ fontSize: 13, fontWeight: "600", color: C.ink }}>
          {t("ui-trace.gauge.title")}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("ui-trace.close")}
          onPress={onClose}
          hitSlop={8}
        >
          <Text style={{ fontSize: 13, color: C.faint }}>×</Text>
        </Pressable>
      </View>
      {rows.map((r) => (
        <View key={r.key} testID={`context-row-${r.key}`} style={{ gap: 2 }}>
          <View
            style={{
              flexDirection: "row",
              justifyContent: "space-between",
              gap: 10,
            }}
          >
            <Text style={{ fontSize: 12, color: C.muted }}>{r.label}</Text>
            <Text
              style={{
                fontSize: 12,
                fontWeight: "600",
                color: r.unavailable ? C.faint : C.ink,
                flexShrink: 1,
                textAlign: "right",
              }}
            >
              {r.value}
            </Text>
          </View>
          {r.note ? (
            <Text style={{ fontSize: 11, color: C.faint, lineHeight: 15 }}>
              {r.note}
            </Text>
          ) : null}
        </View>
      ))}
    </View>
  );
}
