/**
 * DaisyChat's composer kept per conversation: the text being
 * typed, its attachments, 「在终端执行」 runs (finished or still running),
 * the mode itself and an edit in progress survive the chat unmounting — a
 * host route change, the AI drawer switching views, another conversation —
 * and a reload of the tab (sessionStorage; never localStorage, so a draft
 * does not outlive the tab or reach the next person on the browser).
 * Running commands are polled here, not in the component, so a run started
 * before leaving shows its result on return. Free of React for
 * tests/drafts.test.ts.
 */
import type { Attachment, Item, TerminalResult } from "@daisy-ai/contracts";
import { readMigrated } from "./storage-keys";
import { t } from "./i18n";

export type DraftRun = TerminalResult & { status: string };

export interface ChatDraft {
  text: string;
  attachments: Attachment[];
  runs: DraftRun[];
  terminalMode: boolean;
  /** The user message being rewritten. */
  editing: Item | null;
}

export const EMPTY_DRAFT: ChatDraft = Object.freeze({
  text: "",
  attachments: [],
  runs: [],
  terminalMode: false,
  editing: null,
}) as ChatDraft;

const PREFIX = "daisy.draft.v1:";
const drafts = new Map<string, ChatDraft>();
const listeners = new Map<string, Set<() => void>>();

function store(): Storage | null {
  try {
    return typeof window !== "undefined" && window.sessionStorage
      ? window.sessionStorage
      : null;
  } catch {
    return null;
  }
}

function read(sessionId: string): ChatDraft | null {
  try {
    const raw = readMigrated(store(), PREFIX + sessionId);
    if (!raw) return null;
    const d = JSON.parse(raw) as Partial<ChatDraft>;
    return {
      text: typeof d.text === "string" ? d.text : "",
      attachments: Array.isArray(d.attachments) ? d.attachments : [],
      runs: Array.isArray(d.runs) ? d.runs : [],
      terminalMode: d.terminalMode === true,
      editing: d.editing ?? null,
    };
  } catch {
    return null;
  }
}

export function isEmptyDraft(d: ChatDraft) {
  return (
    !d.text &&
    !d.attachments.length &&
    !d.runs.length &&
    !d.terminalMode &&
    !d.editing
  );
}

function write(sessionId: string, d: ChatDraft) {
  const s = store();
  if (!s) return;
  try {
    if (isEmptyDraft(d)) s.removeItem(PREFIX + sessionId);
    else s.setItem(PREFIX + sessionId, JSON.stringify(d));
  } catch {
    // Quota: the in-memory copy still covers route changes.
  }
}

/** Same object until it changes (a useSyncExternalStore snapshot). */
export function getDraft(sessionId: string): ChatDraft {
  let d = drafts.get(sessionId);
  if (!d) {
    d = read(sessionId) ?? EMPTY_DRAFT;
    drafts.set(sessionId, d);
  }
  return d;
}

export function setDraft(
  sessionId: string,
  patch: Partial<ChatDraft> | ((d: ChatDraft) => Partial<ChatDraft>),
) {
  const cur = getDraft(sessionId);
  const next = {
    ...cur,
    ...(typeof patch === "function" ? patch(cur) : patch),
  };
  drafts.set(sessionId, next);
  write(sessionId, next);
  for (const fn of listeners.get(sessionId) ?? []) fn();
}

/** A deleted conversation takes its draft with it. */
export function clearDraft(sessionId: string) {
  setDraft(sessionId, EMPTY_DRAFT);
  drafts.delete(sessionId);
}

export function subscribeDraft(sessionId: string, fn: () => void) {
  let set = listeners.get(sessionId);
  if (!set) listeners.set(sessionId, (set = new Set()));
  set.add(fn);
  return () => {
    set.delete(fn);
    if (!set.size) listeners.delete(sessionId);
  };
}

export const runInFlight = (r: DraftRun) =>
  r.status === "running" || r.status === "queued";

const watching = new Set<string>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Poll one 「在终端执行」 run into the draft until it finishes (once per run,
 * however often it is asked). The server keeps results a day, so a run
 * picked up again after a reload still resolves.
 */
export function watchRun(
  client: { shellStatus(id: string): Promise<DraftRun> },
  sessionId: string,
  runId: string,
  { intervalMs = 700, timeoutMs = 200_000 } = {},
) {
  if (watching.has(runId)) return;
  watching.add(runId);
  const settle = (r: DraftRun) =>
    setDraft(sessionId, (d) => ({
      runs: d.runs.map((x) => (x.id === r.id ? r : x)),
    }));
  void (async () => {
    try {
      const until = Date.now() + timeoutMs;
      while (Date.now() < until) {
        await sleep(intervalMs);
        try {
          const r = await client.shellStatus(runId);
          if (r.status === "complete" || r.status === "error") {
            settle(r);
            return;
          }
        } catch (e) {
          if ((e as { status?: number })?.status === 404) break;
        }
      }
      const run = getDraft(sessionId).runs.find((x) => x.id === runId);
      if (run) settle({ ...run, status: "error", error: t("ui-chat.shell.noResult") });
    } finally {
      watching.delete(runId);
    }
  })();
}
