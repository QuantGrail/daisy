/**
 * P2-03 (5.10 「事件出口的格式」, docs/contracts/events.md): the event
 * outlet's shapes — shared with whoever subscribes (an organisation's
 * notification centre, the task-and-chat project; 7.9). Nothing here is
 * Daisy-specific: a card that needs a person appeared, or was resolved.
 *
 * Each event is a CloudEvents 1.0 event in structured JSON mode. 5.10's
 * fields: 序号 `seq`, 类型 `type`, 给谁 `data.recipient`, 标题
 * `data.title`, 点开去哪 `data.link`, 关联对象 `subject` (the card),
 * 发生时间 `time`, 链路号 `traceparent` (W3C, trace.md).
 */

/** The three kinds of card (5.10). */
export const EVENT_CARD_KINDS = ["permission", "question", "invocation"] as const;
export type EventCardKind = (typeof EVENT_CARD_KINDS)[number];

/**
 * events.md §2: each kind's 「出现」 and 「了结」 type. Names carry no
 * product name (any AI host that raises cards for a person can use them).
 * A subscriber ignores a type it does not know (new ones come in minor
 * versions).
 */
export const EVENT_TYPES = {
  /** AI 请求授权: a tool needs the owner's permission (an approval card). */
  permission: {
    opened: "agent.permission.requested",
    resolved: "agent.permission.resolved",
  },
  /** AI 提问: the AI asks the owner a question. */
  question: {
    opened: "agent.question.asked",
    resolved: "agent.question.resolved",
  },
  /** 有人想调用，待批准: a caller not yet authorised (stage 4). */
  invocation: {
    opened: "agent.invocation.requested",
    resolved: "agent.invocation.resolved",
  },
} as const satisfies Record<EventCardKind, { opened: string; resolved: string }>;
export type DaisyEventType =
  (typeof EVENT_TYPES)[EventCardKind][keyof (typeof EVENT_TYPES)[EventCardKind]];
export const DAISY_EVENT_TYPES: readonly DaisyEventType[] = EVENT_CARD_KINDS.flatMap(
  (k) => [EVENT_TYPES[k].opened, EVENT_TYPES[k].resolved],
);

/** How a card was resolved (events.md §1 `state`). */
export const EVENT_RESOLUTIONS = ["handled", "expired", "canceled"] as const;
export type EventResolution = (typeof EVENT_RESOLUTIONS)[number];

export interface DaisyEventData {
  /** 给谁: the recipient's principal (standalone: this Daisy's owner URN). */
  recipient: string;
  /** 标题: one line for a person, at most 200 characters. */
  title: string;
  /** 点开去哪: a path relative to the sender's local web page. */
  link: string;
  /** True on a 「出现」 event. */
  actionRequired: boolean;
  /** RFC 3339: after this the card needs no reminder. */
  expiresAt?: string;
  /** Display-only names; never conversation content. */
  context?: { agentName?: string; callerName?: string };
  /** Only on a 「了结」 event: how the card ended. */
  state?: EventResolution;
}

/** One event (CloudEvents 1.0, structured JSON). */
export interface DaisyEvent {
  specversion: "1.0";
  /** Unique; subscribers de-duplicate by it. */
  id: string;
  /** The sender: this Daisy's identity URN (token.md §3). */
  source: string;
  type: DaisyEventType;
  /** The card's id: a card's 「出现」 and 「了结」 share it. */
  subject: string;
  /** RFC 3339. */
  time: string;
  /** Extension: strictly increasing within `source`, may have gaps. */
  seq: number;
  /** Extension (CloudEvents distributed tracing): the 链路号. */
  traceparent: string;
  datacontenttype: "application/json";
  data: DaisyEventData;
}

/** `GET /api/events`: one page, oldest first. */
export interface EventsPage {
  events: DaisyEvent[];
  /** The last event's `seq` (the request's `after` when empty): the next `after`. */
  cursor: number;
  /** More are waiting: read again at once. */
  hasMore: boolean;
}

/** `GET /api/events/snapshot`: every open card's 「出现」 event, and where to read on. */
export interface EventsSnapshot {
  events: DaisyEvent[];
  cursor: number;
  snapshot: true;
}

/**
 * events.md §4: the answer (HTTP 410, code `cursor_reset`) when `after`
 * cannot be continued — older than what was kept, or beyond what this
 * sender ever wrote (its data rebuilt). Take a snapshot, read on from its
 * cursor.
 */
export interface EventsReset {
  error: string;
  code: "cursor_reset";
  events: [];
  cursor: 0;
  hasMore: false;
  reset: true;
}
export const EVENTS_RESET_CODE = "cursor_reset";
