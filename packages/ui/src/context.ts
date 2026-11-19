/**
 * DaisyChat's "attach the host page context?" decision (fb3 F2), kept free
 * of React so it is unit-tested (tests/context-gate.test.ts).
 */
import type { Item, MessageContext } from "@daisy-ai/contracts";

/**
 * Key of the latest user message in this session that carried a context and
 * reached (or will reach) the Agent: cancelled / failed messages do not count.
 */
export function latestContextKey(items: readonly Item[]): string | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (
      it.kind === "user" &&
      it.context &&
      it.status !== "cancelled" &&
      it.status !== "error"
    )
      return it.context.key;
  }
  return null;
}

/** Per-conversation state next to the snapshot. */
export interface ContextGate {
  /** Context key the user closed (×) for the next message only. */
  skipKey: string | null;
  /** Context accepted by Daisy whose item the snapshot does not show yet. */
  sent: { key: string; itemId: string } | null;
}
export const initialContextGate: ContextGate = { skipKey: null, sent: null };

export interface ContextPlan {
  /** This session already carries the same key: shown as 「已附带」, not re-sent. */
  attached: boolean;
  /** The user closed it for the next message. */
  skipped: boolean;
  /** The draft is a `/` command, which never carries a context. */
  command: boolean;
  /** What the next send carries (null = nothing). */
  attach: MessageContext | null;
}

export function contextPlan(
  context: MessageContext | null,
  items: readonly Item[],
  gate: ContextGate,
  draft: string,
  /**
   * The server's answer over the whole conversation (`Snapshot.contextKey`);
   * undefined (an older server) = look in the loaded items, which
   * may be only the newest part of a long conversation.
   */
  serverKey?: string | null,
): ContextPlan {
  const command = draft.startsWith("/");
  if (!context)
    return { attached: false, skipped: false, command, attach: null };
  const latest = serverKey !== undefined ? serverKey : latestContextKey(items);
  const attached = latest === context.key || gate.sent?.key === context.key;
  const skipped = gate.skipKey === context.key;
  return {
    attached,
    skipped,
    command,
    attach: attached || skipped || command ? null : context,
  };
}

/**
 * After Daisy accepted a message. `itemId` is the user item it creates
 * (`user:<job>` for send, `input:<id>` for steer). 「不附带」 covers one
 * message, so it clears — except for a `/` command, which never carried it.
 */
export function gateAfterSend(
  gate: ContextGate,
  sent: { carried: MessageContext | null; itemId: string; command: boolean },
): ContextGate {
  return {
    skipKey: sent.command ? gate.skipKey : null,
    sent: sent.carried
      ? { key: sent.carried.key, itemId: sent.itemId }
      : gate.sent,
  };
}

/** The snapshot is authoritative once it shows the sent item. */
export function gateAfterSnapshot(
  gate: ContextGate,
  items: readonly Item[],
): ContextGate {
  return gate.sent && items.some((i) => i.id === gate.sent!.itemId)
    ? { ...gate, sent: null }
    : gate;
}

/** A different page context: a previous 「不附带」 no longer applies. */
export function gateOnContextKey(
  gate: ContextGate,
  key: string | null,
): ContextGate {
  return gate.skipKey !== null && gate.skipKey !== key
    ? { ...gate, skipKey: null }
    : gate;
}
