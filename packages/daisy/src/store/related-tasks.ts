import type {
  MessageContext,
  RelatedTask,
} from "../../../contracts/src/index.ts";
// A session's related host tasks, fb3 F3 (P1-00: moved from store.ts).
/** session.relatedTasks keeps at most this many tasks (fb3 F3). */
export const RELATED_TASKS_MAX = 50;
/**
 * Fold a message context's task refs into a related-task list: a ref already
 * present gets its title (when non-empty), url (when given) and lastSeenAt
 * refreshed and moves to the front; the list stays newest first, capped.
 */
export function mergeRelatedTasks(
  list: RelatedTask[] | undefined,
  refs: MessageContext["refs"],
  now: number,
): RelatedTask[] {
  const out = [...(list || [])];
  const seen = new Set<string>();
  const fresh: RelatedTask[] = [];
  for (const ref of refs) {
    if (ref.kind !== "task" || seen.has(ref.id)) continue;
    seen.add(ref.id);
    const at = out.findIndex((t) => t.id === ref.id),
      old = at >= 0 ? out.splice(at, 1)[0] : undefined,
      url = ref.url ?? old?.url;
    fresh.push({
      id: ref.id,
      title: ref.title || old?.title || "",
      ...(url !== undefined ? { url } : {}),
      lastSeenAt: now,
    });
  }
  return [...fresh, ...out].slice(0, RELATED_TASKS_MAX);
}
