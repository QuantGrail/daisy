/**
 * A queued row's text (2026-11-08: 「看不到排队的内容」): one line
 * by default; tap / click to read it in full — the whole queued text and,
 * for a message that carries Daisy wakes, what goes with it —
 * tap again to fold. The checkbox and buttons beside it are unchanged.
 */
import React from "react";
import { Pressable, Text } from "react-native";
import { useDaisyTheme } from "./theme";
import { useT } from "./i18n";

export interface QueueRowItem {
  id: string;
  text: string;
  /** Daisy wakes riding this message (GET …/queue `carriedItems`). */
  carriedItems?: {
    id: string;
    from?: string;
    text: string;
    truncated?: boolean;
  }[];
}
export function QueueRowText({
  q,
  prefix,
  expanded,
  onToggle,
}: {
  q: QueueRowItem;
  /** 「插队 · 」「已合并 N 条 · 」 … */
  prefix: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { C, s } = useDaisyTheme();
  const t = useT();
  const carried = q.carriedItems || [];
  return (
    <Pressable
      testID={`queue-text-${q.id}`}
      accessibilityRole="button"
      accessibilityState={{ expanded }}
      accessibilityLabel={expanded ? t("ui-chat.queue.collapse") : t("ui-chat.queue.expand")}
      onPress={onToggle}
      style={{ flex: 1, minWidth: 0 }}
    >
      <Text
        numberOfLines={expanded ? undefined : 1}
        selectable={expanded}
        style={s.muted}
      >
        {prefix}
        {q.text || t("ui-chat.queue.noText")}
        {!expanded && carried.length
          ? t("ui-chat.queue.carried", { count: carried.length })
          : ""}
      </Text>
      {expanded
        ? carried.map((c) => (
            <Text
              key={c.id}
              testID={`queue-carried-${c.id}`}
              selectable
              style={{ fontSize: 11, color: C.muted, marginTop: 4 }}
            >
              {t("ui-chat.queue.carriedItem", {
                from: c.from || t("ui-chat.queue.carriedFrom"),
                text: c.text,
                truncated: c.truncated ? t("ui-chat.queue.carriedTruncated") : "",
              })}
            </Text>
          ))
        : null}
    </Pressable>
  );
}
