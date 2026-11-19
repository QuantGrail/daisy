import { agentLetter } from "@daisy-ai/contracts";
import React, { useCallback, useEffect, useState } from "react";
import { Platform, Pressable, ScrollView, View } from "react-native";
import type { Agent } from "@daisy-ai/contracts";
import { Text } from "./primitives";
import { ChatIcon } from "./chat-icons";
import { useChatTokens } from "./chat-tokens";
import { useDaisyTheme } from "./theme";
import { hostConventions } from "./host-conventions";
import { readMigrated } from "./storage-keys";
import { useT } from "./i18n";

/**
 * Collapsible secondary sidebar (2026-10-30): the session list folds to a
 * narrow rail.
 * Shared convention with an embedding host's sidebars: a toggle button at
 * the top of the sidebar, state per browser under
 * `<sidebarKeyPrefix><name>` (host-conventions.ts). ⌘/Ctrl + B folds the
 * host's main navigation; ⌘/Ctrl + Shift + B folds the page's secondary
 * sidebar — here the innermost one (an inner one marks the event handled,
 * outer ones then ignore it). Not while typing in a text field, and never
 * Chrome's bookmarks bar (preventDefault). The host's
 * `secondaryToggleEvent` window event toggles it too.
 */
export const SIDEBAR_SHORTCUT = "Ctrl/⌘ + Shift + B";
const read = (key: string, legacy?: string) => {
  if (Platform.OS !== "web") return false;
  try {
    return readMigrated(window.localStorage, key, legacy) === "collapsed";
  } catch {
    return false;
  }
};
/**
 * P6-03 (ADR-153): Daisy's own session list was kept under the name
 * `harbor`; it is `sessions` now (the old state is moved on first read).
 */
const LEGACY_SIDEBAR_NAME: Record<string, string> = { sessions: "harbor" };
/** Focus in a text field / editor: the shortcut belongs to it. */
export function isEditableTarget(t: EventTarget | null) {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  if (el.isContentEditable) return true;
  if (el.tagName === "TEXTAREA" || el.tagName === "SELECT") return true;
  if (el.tagName === "INPUT")
    return ![
      "button",
      "checkbox",
      "radio",
      "submit",
      "reset",
      "range",
      "color",
      "file",
    ].includes((el as HTMLInputElement).type);
  // A terminal (xterm) takes every key it is given.
  return !!el.closest?.(".xterm");
}
/** ⌘/Ctrl + Shift + B, not already handled, not in a text field. */
export function isSecondarySidebarShortcut(e: KeyboardEvent) {
  return (
    !e.defaultPrevented &&
    (e.ctrlKey || e.metaKey) &&
    e.shiftKey &&
    !e.altKey &&
    !e.repeat &&
    (e.code === "KeyB" || e.key.toLowerCase() === "b") &&
    !isEditableTarget(e.target)
  );
}
export function useSidebarCollapsed(name: string, active = true) {
  const prefix = hostConventions().sidebarKeyPrefix;
  const key = prefix + name;
  const [collapsed, setCollapsed] = useState(() =>
    read(key, LEGACY_SIDEBAR_NAME[name] && prefix + LEGACY_SIDEBAR_NAME[name]),
  );
  const toggle = useCallback(() => {
    setCollapsed((c) => {
      try {
        window.localStorage.setItem(key, c ? "expanded" : "collapsed");
      } catch {
        /* private mode: this page only */
      }
      return !c;
    });
  }, [key]);
  useEffect(() => {
    if (Platform.OS !== "web" || !active) return;
    const onKey = (e: KeyboardEvent) => {
      if (!isSecondarySidebarShortcut(e)) return;
      e.preventDefault();
      toggle();
    };
    // The host's 「toggle the secondary sidebar」 (menu, command palette):
    // the innermost one takes it.
    const onToggle = (e: Event) => {
      if (e.defaultPrevented) return;
      e.preventDefault();
      toggle();
    };
    // Other tabs of this browser follow the change.
    const onStorage = (e: StorageEvent) => {
      if (e.key === key) setCollapsed(e.newValue === "collapsed");
    };
    // One secondary sidebar now (the session list): bubble phase.
    const capture = false;
    const toggleEvent = hostConventions().secondaryToggleEvent;
    document.addEventListener("keydown", onKey, { capture });
    window.addEventListener(toggleEvent, onToggle, { capture });
    window.addEventListener("storage", onStorage);
    return () => {
      document.removeEventListener("keydown", onKey, { capture });
      window.removeEventListener(toggleEvent, onToggle, {
        capture,
      });
      window.removeEventListener("storage", onStorage);
    };
  }, [toggle, key, active, name]);
  return [collapsed, toggle] as const;
}

/** The toggle button at the top of a sidebar (or of its rail). */
export function SidebarToggle({
  collapsed,
  onPress,
  testID,
}: {
  collapsed: boolean;
  onPress: () => void;
  testID?: string;
}) {
  const P = useChatTokens();
  const t = useT();
  const label = t(collapsed ? "ui-queue.sidebar.expand" : "ui-queue.sidebar.collapse", { shortcut: SIDEBAR_SHORTCUT });
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ expanded: !collapsed }}
      onPress={onPress}
      {...(Platform.OS === "web" ? ({ title: label } as any) : {})}
      style={({ pressed, hovered }: any) => ({
        width: 32,
        height: 32,
        borderRadius: 8,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: pressed || hovered ? P.field : "transparent",
      })}
    >
      <ChatIcon name="sidebar" size={18} color={P.secondary} />
    </Pressable>
  );
}

export interface RailItem {
  id: string;
  title: string;
  selected?: boolean;
  agent?: Agent;
  /** A live status dot. */
  statusColor?: string;
}
/** An AI conversation's mark: the agent's letter on its tint. */
function AgentGlyph({ agent }: { agent?: Agent }) {
  const P = useChatTokens();
  const { agents } = useDaisyTheme();
  const tint = agents[agent || "claude"] || P.aiInk;
  return (
    <View
      style={{
        width: 22,
        height: 22,
        borderRadius: 6,
        backgroundColor: tint + "1F",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Text style={{ fontSize: 12, fontWeight: "700", color: tint }}>
        {agent === "codex" ? "C" : agent === "claude" || !agent ? "✳" : agentLetter(agent)}
      </Text>
    </View>
  );
}
const RailButton = React.memo(
  function RailButton({
    item,
    onOpen,
  }: {
    item: RailItem;
    onOpen: (item: RailItem) => void;
  }) {
    const P = useChatTokens();
    const { C } = useDaisyTheme();
    return (
      <Pressable
        testID={`chat-rail-${item.id}`}
        accessibilityRole="button"
        accessibilityState={{ selected: !!item.selected }}
        accessibilityLabel={item.title}
        onPress={() => onOpen(item)}
        {...(Platform.OS === "web" ? ({ title: item.title } as any) : {})}
        style={({ pressed, hovered }: any) => ({
          width: 40,
          height: 36,
          borderRadius: 8,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: item.selected
            ? C.soft
            : pressed || hovered
              ? P.field
              : "transparent",
        })}
      >
        <View>
          <AgentGlyph agent={item.agent} />
          {item.statusColor ? (
            <View
              style={{
                position: "absolute",
                right: -3,
                bottom: -3,
                width: 9,
                height: 9,
                borderRadius: 5,
                borderWidth: 2,
                borderColor: P.surface,
                backgroundColor: item.statusColor,
              }}
            />
          ) : null}
        </View>
      </Pressable>
    );
  },
  (a, b) =>
    a.onOpen === b.onOpen &&
    (Object.keys(a.item) as (keyof RailItem)[]).every(
      (k) => a.item[k] === b.item[k],
    ) &&
    Object.keys(a.item).length === Object.keys(b.item).length,
);

/** Collapsed sidebar: toggle, compose, then one glyph per session. */
export function SidebarRail({
  items,
  onOpen,
  onExpand,
  onCompose,
  composeLabel,
  background,
  testID,
}: {
  items: RailItem[];
  onOpen: (item: RailItem) => void;
  onExpand: () => void;
  onCompose?: () => void;
  composeLabel?: string;
  background?: string;
  testID?: string;
}) {
  const P = useChatTokens();
  const { C } = useDaisyTheme();
  const t = useT();
  composeLabel ??= t("ui-queue.sidebar.compose");
  const rest = items;
  return (
    <View
      testID={testID}
      style={{
        width: 60,
        alignItems: "center",
        borderRightWidth: 1,
        borderColor: P.line,
        backgroundColor: background || P.surface,
        paddingTop: 12,
        gap: 6,
        minHeight: 0,
      }}
    >
      <SidebarToggle
        collapsed
        onPress={onExpand}
        testID={testID ? testID + "-toggle" : undefined}
      />
      {onCompose ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={composeLabel}
          onPress={onCompose}
          {...(Platform.OS === "web" ? ({ title: composeLabel } as any) : {})}
          style={({ pressed, hovered }: any) => ({
            width: 32,
            height: 32,
            borderRadius: 8,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: pressed || hovered ? P.field : "transparent",
          })}
        >
          <ChatIcon name="compose" size={17} color={P.secondary} />
        </Pressable>
      ) : null}
      <View
        style={{ height: 1, alignSelf: "stretch", backgroundColor: P.line }}
      />
      <ScrollView
        style={{ flex: 1, alignSelf: "stretch" }}
        contentContainerStyle={{
          alignItems: "center",
          gap: 4,
          paddingVertical: 6,
        }}
      >
        {Platform.OS === "web" && rest.length > 16
          ? // Blocks of 16 skip layout / paint off screen (content-
            // visibility), so showing the rail paints only what is in view.
            Array.from({ length: Math.ceil(rest.length / 16) }, (_, b) => {
              const part = rest.slice(b * 16, b * 16 + 16);
              return React.createElement(
                "div",
                {
                  key: "b" + b,
                  style: {
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    gap: 4,
                    contentVisibility: "auto",
                    containIntrinsicSize: `auto ${part.length * 40}px`,
                  },
                },
                part.map((item) => (
                  <RailButton key={item.id} item={item} onOpen={onOpen} />
                )),
              );
            })
          : rest.map((item) => (
              <RailButton key={item.id} item={item} onOpen={onOpen} />
            ))}
      </ScrollView>
    </View>
  );
}
