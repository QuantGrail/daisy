/**
 * P1-08: the session notifications in the local web page (3.6: Daisy shows
 * them in its page; pushing to a phone is not Daisy's). GET
 * /api/notifications: 一轮结束 (ai_private_message), 审批卡片 (approval,
 * open → pending, closed → handled / canceled / expired), AI 出错
 * (ai_failed). Shown in a panel and as marks on the session list. What
 * the viewer has looked at is remembered per browser (localStorage, a
 * convenience only); no browser notifications (they need a secure context
 * and a permission — docs/WEB-ORIGINS.md).
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import type { DaisyClient } from "@daisy-ai/client";
import type { NotificationItem } from "@daisy-ai/contracts";
import { Badge, Button, Text } from "./primitives";
import { useDaisyTheme } from "./theme";
import { useT } from "./i18n";
import { useDaisyTime } from "./host";
import { unseenCount } from "./settings-view";

const SEEN_KEY = "daisy.notifications.seen.v1";
const readSeen = () => {
  try {
    return Number(globalThis.localStorage?.getItem(SEEN_KEY)) || 0;
  } catch {
    return 0;
  }
};
const writeSeen = (n: number) => {
  try {
    globalThis.localStorage?.setItem(SEEN_KEY, String(n));
  } catch {
    /* private mode: this page only */
  }
};

export interface SessionNotifications {
  items: NotificationItem[];
  /** Items changed since the viewer last opened the panel. */
  unseen: number;
  /** Open items (pending approvals, unseen turn ends / errors) per session. */
  bySession: Map<string, NotificationItem[]>;
  markSeen: () => void;
  refresh: () => Promise<void>;
}

export function useSessionNotifications(
  client: DaisyClient,
  everyMs = 6000,
): SessionNotifications {
  const [items, setItems] = useState<NotificationItem[]>([]),
    [seen, setSeen] = useState(readSeen),
    [cursor, setCursor] = useState(0);
  const refresh = useCallback(async () => {
    try {
      const r = await client.notifications({ limit: 50, device: "web" });
      setItems(r.items);
      setCursor(r.cursor);
    } catch {
      /* the list keeps what it had; the page shows its own errors */
    }
  }, [client]);
  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), everyMs);
    return () => clearInterval(t);
  }, [refresh, everyMs]);
  const bySession = useMemo(() => {
    const m = new Map<string, NotificationItem[]>();
    for (const n of items) {
      if (!n.sessionId) continue;
      const open =
        n.state === "pending" || (n.state === "unread" && Number(n.id) > seen);
      if (!open) continue;
      m.set(n.sessionId, [...(m.get(n.sessionId) || []), n]);
    }
    return m;
  }, [items, seen]);
  return {
    items,
    unseen: unseenCount(items, seen),
    bySession,
    markSeen: () => {
      setSeen(cursor);
      writeSeen(cursor);
    },
    refresh,
  };
}

/** The core's kinds (`ui-inbox.notify.kind.<kind>`); any other (a plugin's) shows as its id. */
const KINDS = new Set(["approval", "ai_private_message", "ai_failed", "task"]);
/** The states with a word (`ui-inbox.notify.state.<state>`). */
const STATES = new Set(["pending", "handled", "canceled", "expired"]);

/** A small mark for a session row: 待审批 / 出错 / 完成. */
export function SessionMark({ items }: { items?: NotificationItem[] }) {
  const { C } = useDaisyTheme();
  const t = useT();
  if (!items?.length) return null;
  const approval = items.some((n) => n.category === "approval" && n.state === "pending");
  const failed = items.some((n) => n.category === "ai_failed");
  const text = approval
    ? t("ui-inbox.notify.mark.approval")
    : failed
      ? t("ui-inbox.notify.mark.failed")
      : t("ui-inbox.notify.mark.done");
  const color = approval ? C.orange : failed ? C.red : C.green;
  return (
    <Text testID="session-notice" style={{ fontSize: 10, color, fontWeight: "700" }}>
      {t("ui-inbox.notify.mark", { mark: text })}
    </Text>
  );
}

export function NotificationsButton({
  n,
  onPress,
}: {
  n: SessionNotifications;
  onPress: () => void;
}) {
  const t = useT();
  return (
    <Button
      variant="ghost"
      testID="notifications-open"
      onPress={onPress}
      style={{ alignItems: "flex-start" }}
    >
      {n.unseen ? t("ui-inbox.notify.buttonUnseen", { count: n.unseen }) : t("ui-inbox.notify.button")}
    </Button>
  );
}

export function NotificationList({
  n,
  onOpenSession,
  onClose,
}: {
  n: SessionNotifications;
  onOpenSession: (id: string) => void;
  onClose: () => void;
}) {
  const { C, s, rad } = useDaisyTheme();
  const when = useDaisyTime();
  const t = useT();
  // Opening the panel is looking at them.
  useEffect(() => {
    n.markSeen();
  }, [n.items.length]);
  return (
    <View testID="notifications-panel" style={{ flex: 1, padding: 16, gap: 12 }}>
      <View style={[s.row, { justifyContent: "space-between" }]}>
        <Text style={{ fontSize: 18, fontWeight: "600", color: C.ink }}>{t("ui-inbox.notify.title")}</Text>
        <Button variant="ghost" onPress={onClose}>
          {t("ui-inbox.notify.close")}
        </Button>
      </View>
      <ScrollView contentContainerStyle={{ gap: 8 }}>
        {n.items.length ? (
          n.items.map((x) => {
            const closed = ["handled", "canceled", "expired"].includes(x.state);
            return (
              <Pressable
                key={x.notificationId}
                testID={`notification-${x.category || x.kind}`}
                accessibilityRole="button"
                disabled={!x.sessionId}
                onPress={() => x.sessionId && onOpenSession(x.sessionId)}
                style={({ pressed }) => ({
                  padding: 12,
                  gap: 4,
                  borderRadius: rad(10),
                  borderWidth: 1,
                  borderColor: C.line,
                  backgroundColor: pressed ? C.bg : C.paper,
                  opacity: closed ? 0.6 : 1,
                })}
              >
                <View style={[s.row, { flexWrap: "wrap" }]}>
                  <Badge
                    text={KINDS.has(x.kind) ? t.dynamic(`ui-inbox.notify.kind.${x.kind}`) : x.kind}
                    color={
                      x.category === "approval"
                        ? C.orange
                        : x.category === "ai_failed"
                          ? C.red
                          : C.green
                    }
                  />
                  {STATES.has(x.state) ? (
                    <Text style={{ fontSize: 11, color: C.muted }}>{t.dynamic(`ui-inbox.notify.state.${x.state}`)}</Text>
                  ) : null}
                  <Text style={{ fontSize: 11, color: C.muted, flex: 1, textAlign: "right" }}>
                    {when.date(x.created)} {when.time(x.created)}
                  </Text>
                </View>
                <Text style={{ fontSize: 13, color: C.ink }}>{x.title || t("ui-inbox.notify.untitled")}</Text>
              </Pressable>
            );
          })
        ) : (
          <Text style={s.muted}>{t("ui-inbox.notify.empty")}</Text>
        )}
      </ScrollView>
    </View>
  );
}
