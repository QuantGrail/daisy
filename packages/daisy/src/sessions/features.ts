/**
 * P4-11 (plan §5.5, acceptance C-3, ADR-131): what a session's AI declares
 * it can do on its device — read from the node's report
 * (`capabilities.agentFeatures[agent]`, contracts agent-features.ts) — and
 * the one refusal for a call that needs a capability it does not declare:
 * 409 `capability_unsupported`, the sentence 「这个 AI 不支持 X」 and a
 * `fix` (what to do instead) the command line prints as 怎么办.
 */
import {
  CAPABILITY_UNSUPPORTED,
  featuresFor,
  unsupportedFix,
  unsupportedMessage,
  type AgentFeature,
  type AgentFeatureMap,
} from "../../../contracts/src/agent-features.ts";
import { normalizeNodeCapabilities } from "../../../contracts/src/agent-capabilities.ts";
import { HttpError } from "../app/errors.ts";
import type { Translate } from "../../../contracts/src/i18n.ts";
import { ownerT } from "../platform/language.ts";
import type { Session } from "../../../contracts/src/index.ts";

interface CapsStore {
  one(sql: string, ...args: any[]): any;
}
/** Parsed once per report (the raw text is the key). */
const seen = new WeakMap<object, Map<string, { raw: string; caps: any }>>();
export function nodeCapabilities(store: CapsStore, nodeId: string): any {
  const raw =
    store.one("SELECT capabilities FROM nodes WHERE id=?", nodeId)
      ?.capabilities || "{}";
  let byNode = seen.get(store);
  if (!byNode) seen.set(store, (byNode = new Map()));
  let hit = byNode.get(nodeId);
  if (!hit || hit.raw !== raw) {
    let caps: any = {};
    try {
      // ADR-152: old `"harbor"` values (a row written before) read as new.
      caps = normalizeNodeCapabilities(JSON.parse(raw));
    } catch {}
    byNode.set(nodeId, (hit = { raw, caps }));
  }
  return hit.caps;
}
/** The session's AI, flattened (§5.5). */
export function sessionFeatures(
  store: CapsStore,
  s: Pick<Session, "agent" | "nodeId">,
): AgentFeatureMap {
  return featuresFor(nodeCapabilities(store, s.nodeId), s.agent);
}
/** A refusal for an undeclared capability (code, sentence, what to do). */
export function capabilityError(
  agent: string,
  k: AgentFeature,
  m?: AgentFeatureMap,
  /** P6-23b: the reader's language (default the owner's). */
  t: Translate = ownerT(),
): HttpError {
  return Object.assign(
    new HttpError(409, unsupportedMessage(agent, k, t), CAPABILITY_UNSUPPORTED),
    { fix: unsupportedFix(k, m, t) },
  );
}
/** Refuse unless the session's AI declares every one of `keys`. */
export function requireFeatures(
  store: CapsStore,
  s: Pick<Session, "agent" | "nodeId">,
  ...keys: AgentFeature[]
): AgentFeatureMap {
  const m = sessionFeatures(store, s);
  for (const k of keys)
    if (m[k] === "none") throw capabilityError(s.agent, k, m);
  return m;
}
/** The capability a session operation needs (null: none of §5.5's). */
export function operationFeature(
  name: string,
  args: Record<string, unknown> = {},
): AgentFeature[] {
  if (name === "rewind")
    return args.files === true ? ["rewind", "rewindFiles"] : ["rewind"];
  if (name === "fork" || name === "compact" || name === "terminal")
    return [name];
  return [];
}
