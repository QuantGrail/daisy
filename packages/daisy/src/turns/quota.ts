import { turnT } from "../harness/model-switch.ts";
import { acpHarness, harnessText } from "../../../contracts/src/acp-harnesses.ts";
import {
  isGlmBaseUrl,
  type QuotaSnapshot,
  type QuotaWindow,
  type RunnerJob,
} from "../../../contracts/src/index.ts";
/**
 * Plan quota per identity, Runner side. Claude subscriptions:
 * the CLI's get_usage control request (Experimental) at most every 5
 * minutes per identity, with rate_limit_event filling in between and as the
 * fallback when get_usage fails. Codex (ChatGPT login): the app-server's
 * account/rateLimits. GLM Coding Plan (API key on open.bigmodel.cn / z.ai):
 * the provider's quota endpoint with the identity's own key, at most every
 * 5 minutes per identity. Everything else says why there is none.
 * Only percentages, reset times and the plan name are kept.
 */
export const CLAUDE_USAGE_EVERY_MS = 5 * 60_000;
const latest = new Map<string, QuotaSnapshot>();
const asked = new Map<string, number>();
const toMs = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v) && v > 0)
    return v < 1e12 ? Math.round(v * 1000) : Math.round(v);
  if (typeof v === "string" && v) {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  return null;
};
/**
 * A used percentage, 0–100 (review S2: scaled per source, never guessed
 * from the value). get_usage `utilization` is already a percentage (SDK:
 * "Percentage of the window used, 0-100"); rate_limit_event `utilization`
 * is the fraction from the anthropic-ratelimit-unified-*-utilization
 * headers (0–1, read from the 2.1.316 binary), so it is ×100.
 */
const percent = (v: unknown, scale: 1 | 100): number | null =>
  typeof v === "number" && Number.isFinite(v)
    ? Math.max(0, Math.min(1000, v * scale))
    : null;
const planName = (t: unknown) =>
  typeof t === "string" && t ? t.slice(0, 40) : null;
export const isGlm = (job: RunnerJob) => isGlmBaseUrl(job.profile.baseUrl);
/** What an identity without a quota source shows (and why). */
export function staticQuota(job: RunnerJob): QuotaSnapshot | null {
  const base = {
    v: 1 as const,
    profileId: job.profile.id,
    windows: [],
    fetchedAt: Date.now(),
    via: "none" as const,
  };
  const agent = job.session.agent;
  if (agent === "claude" && job.profile.authMode === "apiKey")
    return isGlm(job)
      ? {
          ...base,
          provider: "glm-coding",
          status: "unavailable",
          reason: turnT()("server-turns.quota.glmNotYet"),
          plan: {
            name: job.profile.label.slice(0, 100),
            source: "identity-label",
          },
        }
      : {
          ...base,
          provider: "api-key",
          status: "not-applicable",
          reason: turnT()("server-turns.quota.apiKey"),
          plan: { name: null, source: "unknown" },
        };
  if (agent === "codex")
    return {
      ...base,
      provider: "codex-chatgpt",
      status: "unavailable",
      reason:
        turnT()("server-turns.quota.codexNotYet"),
      plan: { name: null, source: "unknown" },
    };
  // P4-10: ACP has no quota; each harness says why (acp-harnesses.ts).
  const acp = acpHarness(agent);
  if (acp)
    return {
      ...base,
      provider: acp.quota.provider ?? "unknown",
      status: "unavailable",
      reason: harnessText(acp, "quotaReason", turnT()),
      plan: { name: null, source: "unknown" },
    };
  return null;
}
/** The identity's newest snapshot this Runner holds. */
export const quotaOf = (profileId: string) => latest.get(profileId);
/** Time to ask get_usage again for this identity? */
export function usageDue(profileId: string, now = Date.now()) {
  return now - (asked.get(profileId) ?? 0) >= CLAUDE_USAGE_EVERY_MS;
}
export function markAsked(profileId: string, now = Date.now()) {
  asked.set(profileId, now);
}
const WINDOWS: [string, QuotaWindow["kind"], string?][] = [
  ["five_hour", "five_hour"],
  ["seven_day", "weekly"],
  ["seven_day_opus", "weekly_model", "Opus"],
  ["seven_day_sonnet", "weekly_model", "Sonnet"],
];
/** A get_usage answer → the identity's snapshot (null: not one). */
export function fromClaudeUsage(
  profileId: string,
  r: any,
  now = Date.now(),
): QuotaSnapshot | null {
  if (
    !r ||
    typeof r !== "object" ||
    typeof r.rate_limits_available !== "boolean"
  )
    return null;
  const plan = {
    name: planName(r.subscription_type),
    source: "provider" as const,
  };
  if (!r.rate_limits_available || !r.rate_limits)
    return {
      v: 1,
      profileId,
      provider: "claude-subscription",
      status: "unavailable",
      reason: turnT()("server-turns.quota.claudeNone"),
      plan: plan.name ? plan : { name: null, source: "unknown" },
      windows: [],
      fetchedAt: now,
      via: "cli-control",
    };
  const windows: QuotaWindow[] = [];
  for (const [key, kind, label] of WINDOWS) {
    const w = r.rate_limits[key];
    if (!w || typeof w !== "object") continue;
    windows.push({
      kind,
      ...(label ? { label } : {}),
      usedPercent: percent(w.utilization, 1),
      resetsAt: toMs(w.resets_at),
    });
  }
  const snap: QuotaSnapshot = {
    v: 1,
    profileId,
    provider: "claude-subscription",
    status: "ok",
    plan: plan.name ? plan : { name: null, source: "unknown" },
    windows,
    fetchedAt: now,
    via: "cli-control",
  };
  latest.set(profileId, snap);
  return snap;
}
/**
 * A rate_limit_event (passive, every subscription turn): fills that one
 * window into the identity's snapshot — the fallback when get_usage is
 * refused or fails.
 */
export function fromRateLimit(
  profileId: string,
  info: any,
  plan: string | null,
  now = Date.now(),
): QuotaSnapshot | null {
  if (!info || typeof info !== "object") return latest.get(profileId) ?? null;
  const hit = WINDOWS.find(([key]) => key === info.rateLimitType);
  const prev = latest.get(profileId);
  const windows = [...(prev?.status === "ok" ? prev.windows : [])];
  if (hit) {
    const [, kind, label] = hit;
    const at = windows.findIndex(
      (w) => w.kind === kind && (w.label ?? "") === (label ?? ""),
    );
    const usedPercent = percent(info.utilization, 100);
    const resetsAt = toMs(info.resetsAt);
    const next: QuotaWindow = {
      kind,
      ...(label ? { label } : {}),
      // A rate_limit_event without utilization keeps what get_usage said.
      usedPercent: usedPercent ?? (at >= 0 ? windows[at].usedPercent : null),
      resetsAt: resetsAt ?? (at >= 0 ? windows[at].resetsAt : null),
    };
    if (at >= 0) windows[at] = next;
    else windows.push(next);
  }
  if (!windows.length) return prev ?? null;
  const snap: QuotaSnapshot = {
    v: 1,
    profileId,
    provider: "claude-subscription",
    status: "ok",
    plan:
      prev?.plan.name || plan
        ? { name: prev?.plan.name || plan, source: "provider" }
        : { name: null, source: "unknown" },
    windows,
    fetchedAt: now,
    via: prev?.via === "cli-control" ? "cli-control" : "stream",
  };
  latest.set(profileId, snap);
  return snap;
}
const CODEX_PLANS: Record<string, string> = {
  free: "Free",
  go: "Go",
  plus: "Plus",
  pro: "Pro",
  prolite: "Pro Lite",
  team: "Team",
  business: "Business",
  enterprise: "Enterprise",
  edu: "Edu",
};
/** A Codex rate-limit window → ours, by its length (5 h / 7 d); null = neither. */
const codexWindow = (w: any): QuotaWindow | null => {
  if (!w || typeof w !== "object") return null;
  const kind =
    w.windowDurationMins === 300
      ? "five_hour"
      : w.windowDurationMins === 10080
        ? "weekly"
        : null;
  if (!kind) return null;
  return {
    kind,
    usedPercent: percent(w.usedPercent, 1),
    resetsAt: toMs(w.resetsAt),
  };
};
/**
 * Codex's ChatGPT plan quota (app-server `account/rateLimits/read` answer,
 * or an `account/rateLimits/updated` notification, which is sparse: what
 * it leaves out keeps the last value). Only the main `codex` bucket's
 * 5-hour / weekly windows (`usedPercent` is 0–100, `resetsAt` seconds) and
 * the plan type are kept — never the account id, credits or spend data.
 * null: not a rate-limit snapshot (or another bucket).
 */
export function fromCodexRateLimits(
  profileId: string,
  r: any,
  now = Date.now(),
): QuotaSnapshot | null {
  const rl = r?.rateLimits;
  if (!rl || typeof rl !== "object") return null;
  if (rl.limitId != null && rl.limitId !== "codex") return null;
  const prev = latest.get(profileId);
  const windows =
    prev?.provider === "codex-chatgpt" && prev.status === "ok"
      ? [...prev.windows]
      : [];
  for (const w of [codexWindow(rl.primary), codexWindow(rl.secondary)]) {
    if (!w) continue;
    const at = windows.findIndex((x) => x.kind === w.kind);
    if (at >= 0) windows[at] = w;
    else windows.push(w);
  }
  const type = typeof rl.planType === "string" ? rl.planType : null;
  const name =
    type && type !== "unknown"
      ? `ChatGPT ${CODEX_PLANS[type] ?? planName(type)}`
      : prev?.provider === "codex-chatgpt"
        ? prev.plan.name
        : null;
  if (!windows.length && !name) return prev ?? null;
  const snap: QuotaSnapshot = {
    v: 1,
    profileId,
    provider: "codex-chatgpt",
    status: windows.length ? "ok" : "unavailable",
    ...(windows.length
      ? {}
      : { reason: turnT()("server-turns.quota.codexNoWindows") }),
    plan: name
      ? { name: name.slice(0, 100), source: "provider" }
      : { name: null, source: "unknown" },
    windows,
    fetchedAt: now,
    via: "cli-rpc",
  };
  latest.set(profileId, snap);
  return snap;
}
/** GLM Coding Plan quota endpoint (same origin as the Anthropic-compatible base URL). */
export const GLM_QUOTA_PATH = "/api/monitor/usage/quota/limit";
export const GLM_QUOTA_TIMEOUT_MS = 10_000;
/** The quota URL of a GLM identity, or null (no / not a GLM base URL). */
export function glmQuotaUrl(baseUrl: string): string | null {
  try {
    const u = new URL(baseUrl);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return u.origin + GLM_QUOTA_PATH;
  } catch {
    return null;
  }
}
/** A short, single-line reason (never the response body or the key). */
const shortReason = (v: unknown) =>
  String(v ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .trim()
    .slice(0, 80);
/**
 * A GLM quota answer → the identity's snapshot. `data.limits[]`: the
 * TOKENS_LIMIT entries number=5,unit=3 (5 hours) and number=1,unit=6
 * (weekly); `percentage` is the used share (0–100), `nextResetTime` the
 * reset (absent while nothing is used). An entry without number/unit fills
 * the missing window by reset time (the nearer one is the 5-hour window).
 * TIME_LIMIT (MCP calls per month) is not a token window and is skipped.
 */
export function fromGlmQuota(
  profileId: string,
  label: string,
  body: any,
  now = Date.now(),
): QuotaSnapshot {
  const base = {
    v: 1 as const,
    profileId,
    provider: "glm-coding" as const,
    plan: {
      name: label.slice(0, 100) || null,
      source: "identity-label" as const,
    },
    fetchedAt: now,
    via: "http" as const,
  };
  const fail = (why: string): QuotaSnapshot => ({
    ...base,
    status: "error",
    reason: turnT()("server-turns.quota.glmUnavailable", { why }),
    windows: [],
  });
  if (!body || typeof body !== "object") return fail(turnT()("server-turns.quota.notObject"));
  if (body.success === false || (body.code != null && body.code !== 200))
    return fail(shortReason(body.msg) || `code ${shortReason(body.code)}`);
  const limits = body.data?.limits;
  if (!Array.isArray(limits)) return fail(turnT()("server-turns.quota.noLimits"));
  const tokens = limits.filter(
    (l: any) => l && typeof l === "object" && l.type === "TOKENS_LIMIT",
  );
  const window = (l: any, kind: QuotaWindow["kind"]): QuotaWindow => ({
    kind,
    usedPercent: percent(l.percentage, 1),
    resetsAt: toMs(l.nextResetTime),
  });
  const found = new Map<QuotaWindow["kind"], QuotaWindow>();
  const unsure: any[] = [];
  for (const l of tokens) {
    const kind =
      l.number === 5 && l.unit === 3
        ? "five_hour"
        : l.number === 1 && l.unit === 6
          ? "weekly"
          : l.number == null || l.unit == null
            ? null
            : undefined;
    if (kind === undefined) continue; // another window: not shown
    if (kind === null) unsure.push(l);
    else if (!found.has(kind)) found.set(kind, window(l, kind));
  }
  unsure.sort(
    (a, b) =>
      (toMs(a.nextResetTime) ?? Infinity) - (toMs(b.nextResetTime) ?? Infinity),
  );
  for (const l of unsure) {
    const kind = (["five_hour", "weekly"] as const).find((k) => !found.has(k));
    if (!kind) break;
    found.set(kind, window(l, kind));
  }
  const windows = (["five_hour", "weekly"] as const)
    .filter((k) => found.has(k))
    .map((k) => found.get(k)!);
  if (!windows.length)
    return {
      ...base,
      status: "unavailable",
      reason: turnT()("server-turns.quota.glmNoWindows"),
      windows: [],
    };
  return { ...base, status: "ok", windows };
}
/** Largest quota answer read (the real one is well under 2 KiB). */
export const GLM_QUOTA_MAX_BYTES = 64 * 1024;
type FetchLike = (
  url: string,
  init: {
    headers: Record<string, string>;
    signal: AbortSignal;
    redirect: "error";
  },
) => Promise<{
  ok: boolean;
  status: number;
  body?: ReadableStream<Uint8Array> | null;
  text(): Promise<string>;
}>;
/** The answer's text, at most `max` bytes (more = an error, not a cut). */
async function boundedText(
  r: Awaited<ReturnType<FetchLike>>,
  max: number,
): Promise<string> {
  if (!r.body?.getReader) {
    const t = await r.text();
    if (Buffer.byteLength(t) > max) throw new Error("too-large");
    return t;
  }
  const reader = r.body.getReader(),
    parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) {
      await reader.cancel().catch(() => {});
      throw new Error("too-large");
    }
    parts.push(value);
  }
  return Buffer.concat(parts).toString("utf8");
}
/**
 * Asks the GLM quota endpoint with this identity's own API key (sent as is,
 * no "Bearer"; the same key the CLI already sends to that host; no
 * redirect followed, so it never goes anywhere else). Always returns a
 * snapshot — an error one when it cannot be read — and keeps it as the
 * identity's newest. The key is removed from anything the provider says.
 */
export async function fetchGlmQuota(
  job: RunnerJob,
  fetchImpl: FetchLike = fetch as any,
  now = () => Date.now(),
  timeoutMs = GLM_QUOTA_TIMEOUT_MS,
): Promise<QuotaSnapshot> {
  const pid = job.profile.id,
    label = job.profile.label || "";
  const url = glmQuotaUrl(job.profile.baseUrl || "");
  const key = job.profile.apiKey || "";
  const failed = (msg: string) =>
    fromGlmQuota(pid, label, { success: false, msg }, now());
  let snap: QuotaSnapshot;
  if (!url)
    snap = {
      ...failed(""),
      reason: turnT()("server-turns.quota.glmUnavailable", { why: turnT()("server-turns.quota.badBaseUrl") }),
    };
  else if (!key)
    snap = { ...failed(""), reason: turnT()("server-turns.quota.glmUnavailable", { why: turnT()("server-turns.quota.noKey") }) };
  else {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const r = await fetchImpl(url, {
        headers: { Authorization: key, Accept: "application/json" },
        signal: ac.signal,
        redirect: "error",
      });
      if (!r.ok) {
        await r.body?.cancel?.().catch(() => {});
        snap = failed(`HTTP ${r.status}`);
      } else {
        const text = await boundedText(r, GLM_QUOTA_MAX_BYTES);
        let body: any = null;
        try {
          body = JSON.parse(text);
        } catch {
          body = null;
        }
        if (body && typeof body.msg === "string")
          body.msg = body.msg.split(key).join("***");
        snap = fromGlmQuota(pid, label, body, now());
      }
    } catch (e: any) {
      snap = failed(
        ac.signal.aborted
          ? turnT()("server-turns.quota.timeout")
          : e?.message === "too-large"
            ? turnT()("server-turns.quota.tooLarge")
            : turnT()("server-turns.quota.network"),
      );
    } finally {
      clearTimeout(timer);
    }
  }
  latest.set(pid, snap);
  return snap;
}
/** Tests: forget every identity. */
export function resetQuota() {
  latest.clear();
  asked.clear();
}
