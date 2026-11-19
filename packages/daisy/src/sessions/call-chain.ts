/**
 * 调用链的深度与次数预算（P1-01 从聊天的 collaboration.ts 抽出：
 * `trackLineage` 与重试时的预算检查，数值原样保留）。阶段 4 的 A2A 调用
 * 链用它：一次调用记下它属于哪条链、在第几层；同一条链的调用总数有上限。
 *
 * - 深度：链路的第一次调用是第 1 层，由它引起的调用再加一层。超过 8 层
 *   拒绝。
 * - 次数：同一条链（同一个根）累计的调用超过 64 次拒绝。重试算一次新调用。
 * - 只记调用（`calls` > 0）的才加深度、计次数；`calls` 为 0 的记录只把这一
 *   步挂到链上（例如一条只是通知、不要求对方动手的消息）。
 *
 * 链从哪里开始由调用方决定：`parent` 是引起这次调用的那次调用（它的记录
 * 已在表里）；没有时用 `root`（例如 `job:<轮次 ID>`：主人这一轮发起的
 * 链），再没有就以这次调用自己为根。
 */
import type { Store } from "../store/index.ts";
import { ownerT } from "../platform/language.ts";

export const CHAIN_LIMITS = {
  /** Deepest a chain may go (calls caused by calls). */
  depth: 8,
  /** Calls one chain (one root) may make in all, retries included. */
  calls: 64,
} as const;

/** 429 with a stable code (`chain_depth` / `chain_calls`). */
export class ChainLimitError extends Error {
  readonly statusCode = 429;
  readonly apiCode: "chain_depth" | "chain_calls";
  constructor(code: "chain_depth" | "chain_calls", message: string) {
    super(message);
    this.apiCode = code;
  }
}

export interface ChainLink {
  root: string;
  depth: number;
}

export function callChain(
  store: Store,
  limits: { depth: number; calls: number } = CHAIN_LIMITS,
) {
  /** Where call `id` sits, or null when it was never tracked. */
  const of = (id: string): ChainLink | null => {
    const r = store.one(
      "SELECT root_id,depth FROM call_lineage WHERE call_id=?",
      id,
    );
    return r ? { root: r.root_id, depth: Number(r.depth) } : null;
  };
  /** Calls charged to chain `root` so far. */
  const used = (root: string): number =>
    Number(
      store.one("SELECT calls FROM call_budgets WHERE root_id=?", root)
        ?.calls || 0,
    );
  /**
   * Record call `id` (charging `calls`, default 1) under `parent`'s chain;
   * throws ChainLimitError (nothing recorded) when it would go deeper than
   * the limit or over the chain's budget. Run inside the caller's
   * transaction with the call itself.
   */
  function track(o: {
    id: string;
    parent?: string | null;
    root?: string | null;
    calls?: number;
  }): ChainLink {
    const calls = o.calls ?? 1;
    const parent = o.parent ? of(o.parent) : null;
    const root = parent?.root || o.root || o.id;
    const depth = (parent?.depth || 0) + (calls ? 1 : 0);
    if (calls && depth > limits.depth)
      throw new ChainLimitError(
        "chain_depth",
        ownerT()("server-sessions.chain.depth", { n: limits.depth }),
      );
    if (calls && used(root) + calls > limits.calls)
      throw new ChainLimitError(
        "chain_calls",
        ownerT()("server-sessions.chain.calls", { n: limits.calls }),
      );
    store.run(
      "INSERT OR IGNORE INTO call_budgets(root_id) VALUES(?)",
      root,
    );
    store.run(
      "UPDATE call_budgets SET calls=calls+? WHERE root_id=?",
      calls,
      root,
    );
    store.run(
      "INSERT INTO call_lineage(call_id,root_id,depth) VALUES(?,?,?)",
      o.id,
      root,
      depth,
    );
    return { root, depth };
  }
  /**
   * A tracked call is retried: one more call on its chain (refused once
   * the chain has used its budget). An untracked call is not charged.
   */
  function retry(id: string): ChainLink | null {
    const link = of(id);
    if (!link) return null;
    if (used(link.root) >= limits.calls)
      throw new ChainLimitError(
        "chain_calls",
        ownerT()("server-sessions.chain.retry", { n: limits.calls }),
      );
    store.run(
      "UPDATE call_budgets SET calls=calls+1 WHERE root_id=?",
      link.root,
    );
    return link;
  }
  return { of, used, track, retry, limits };
}
export type CallChain = ReturnType<typeof callChain>;
