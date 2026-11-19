/**
 * P4-11 (plan §5.5 「统一的能力清单」, acceptance C-3, ADR-131): one flat
 * map of what the AI of a session can do, read the same way by the
 * control plane (refuses an undeclared capability with
 * `capability_unsupported`), the UI (shows only declared features) and the
 * command line (says 「这个 AI 不支持 X」 and what to do instead).
 *
 * The declaration itself stays agent-capabilities.ts's `AgentCapabilities` (the Runner
 * reports it per agent in `capabilities.agentFeatures`, by CLI version —
 * `capabilitiesFor`); this module only flattens it. A generic ACP harness
 * (P4-10) declares its capabilities in its config entry and
 * `declareCapabilities` turns that into the same report.
 */
import {
  AGENT_CAPABILITIES,
  OPTIONAL_FEATURES,
  REQUIRED_FEATURES,
  capabilitiesFor,
  normalizeCapabilityValues,
  normalizeSupport,
  rewindFilesRoute,
  type AgentCapabilities,
  type AgentFeature,
  type FeatureDeclaration,
  type OptionalFeature,
  type Support,
} from "./agent-capabilities.ts";
import type { Translate } from "./i18n.ts";
import { defaultTranslate } from "./i18n-default.ts";
import { AGENT_IDS, agentShortName } from "./acp-harnesses.ts";

export {
  LEGACY_FALLBACK,
  OPTIONAL_FEATURES,
  REQUIRED_FEATURES,
  isFallback,
  normalizeNodeCapabilities,
  normalizeSupport,
  type AgentFeature,
  type FeatureDeclaration,
  type OptionalFeature,
  type RequiredFeature,
} from "./agent-capabilities.ts";
export type FeatureSupport = Support;
/** Every §5.5 capability of one session's AI on its device. */
export type AgentFeatureMap = Record<AgentFeature, FeatureSupport>;

/** The machine-readable code of a refusal for an undeclared capability. */
export const CAPABILITY_UNSUPPORTED = "capability_unsupported";

export const AGENT_FEATURES: readonly AgentFeature[] = [
  ...REQUIRED_FEATURES,
  ...OPTIONAL_FEATURES,
];

/** How a capability is named to people (the §5.5 row it belongs to). */
/**
 * How a capability is named to people (the §5.5 row it belongs to), in
 * `t`'s language (`ui-contracts.feature.<key>`).
 */
export const featureTitle = (k: AgentFeature, t: Translate = defaultTranslate()): string =>
  t.dynamic(`ui-contracts.feature.${k}`);

/** P4-10: this release's agents — the native two and every ACP harness entry. */
const known = (a: string): boolean => AGENT_IDS.includes(a);

/** The harness's name as people know it (an ACP entry: its short name). */
export function harnessName(agent: string | undefined, t: Translate = defaultTranslate()): string {
  return agent ? agentShortName(agent) : t("ui-contracts.feature.thisAi");
}

/** ADR-152: the old spelling `"harbor"` reads as `"fallback"`. */
const sup = (x: unknown): Support => {
  const v = normalizeSupport(x);
  return v === "native" || v === "fallback" ? v : "none";
};
const setting = (x: unknown): Support | undefined =>
  x === "native" ? "native" : x === "restart" ? "fallback" : undefined;

/**
 * Flatten one agent's declaration. A key declared `none` in `features` is
 * none whatever else says; otherwise the measured block (
 * version-gated by the Runner) wins over the plain declaration.
 */
export function featureMap(
  c: AgentCapabilities | null | undefined,
  decl: FeatureDeclaration = c?.features ?? {},
): AgentFeatureMap {
  const out = {} as AgentFeatureMap;
  const derived: Partial<Record<AgentFeature, Support | undefined>> = c
    ? {
        steer: c.input?.steer?.support === "native" ? "native" : undefined,
        withdraw: c.input?.withdraw ? sup(c.input.withdraw.support) : undefined,
        rewind: c.rewind ? sup(c.rewind.history) : undefined,
        rewindFiles: c.rewind ? sup(c.rewind.files) : undefined,
        model: setting(c.settings?.model),
        effort: setting(c.settings?.effort),
        permissionMode: setting(c.settings?.permissionMode),
        readOnly: c.readOnly ? sup(c.readOnly.support) : undefined,
        askOnly: c.askOnly
          ? c.askOnly.sideQuestion === "native" || c.askOnly.fork === "native"
            ? "native"
            : sup(c.askOnly.fork)
          : undefined,
        background: c.background ? sup(c.background.list?.support) : undefined,
      }
    : {};
  for (const k of REQUIRED_FEATURES)
    out[k] = c ? (decl[k] === undefined ? "native" : sup(decl[k])) : "none";
  for (const k of OPTIONAL_FEATURES)
    out[k] = decl[k] === "none" ? "none" : (derived[k] ?? sup(decl[k]));
  return out;
}

/**
 * What `agent` can do on a node, from that node's report
 * (`capabilities.agentFeatures[agent]`). No report (an older Runner, a node
 * not seen yet): this release's table at an unknown CLI version for the
 * native three, nothing for anything else. A report without `features`
 * (a Runner older than P4-11) takes this release's static ones.
 */
export function featuresFor(nodeCaps: any, agent: string): AgentFeatureMap {
  const r = normalizeCapabilityValues(nodeCaps?.agentFeatures?.[agent]);
  const reported = r && typeof r === "object" && r.version >= 1;
  const c: AgentCapabilities | null = reported
    ? (r as AgentCapabilities)
    : known(agent)
      ? capabilitiesFor(agent, undefined)
      : null;
  const decl =
    (reported && r.features && typeof r.features === "object"
      ? r.features
      : known(agent)
        ? AGENT_CAPABILITIES[agent]!.features
        : undefined) ?? {};
  const m = featureMap(c, decl);
  // File rewind keeps its own older-Runner rule (Claude Code natively).
  if (decl.rewindFiles !== "none" && (reported || known(agent)))
    m.rewindFiles = rewindFilesRoute(nodeCaps, agent);
  return m;
}

/** Whether a feature is offered at all (native, or by Daisy). */
export const offered = (
  m: AgentFeatureMap | null | undefined,
  k: AgentFeature,
) => !m || m[k] !== "none";

/** 「这个 AI 不支持 X」 — the one sentence everywhere. */
export function unsupportedMessage(agent: string | undefined, k: AgentFeature, t: Translate = defaultTranslate()) {
  return t("ui-contracts.feature.unsupported", { harness: harnessName(agent, t), feature: featureTitle(k, t) });
}

/** What to do instead (`m`: the same session's map, to point only at what it has). */
export function unsupportedFix(
  k: AgentFeature,
  m?: AgentFeatureMap | null,
  t: Translate = defaultTranslate(),
): string {
  const terminal = offered(m, "terminal") ? t("ui-contracts.feature.fix.terminalOr") : "";
  const other = t("ui-contracts.feature.fix.other", { feature: featureTitle(k, t) });
  switch (k) {
    case "steer":
      return t("ui-contracts.feature.fix.steer");
    case "withdraw":
      return t("ui-contracts.feature.fix.withdraw");
    case "rewindFiles":
      return t("ui-contracts.feature.fix.rewindFiles", { terminal });
    case "model":
    case "effort":
      return t("ui-contracts.feature.fix.model", { feature: featureTitle(k, t) });
    case "readOnly":
    case "askOnly":
      return t("ui-contracts.feature.fix.askOnly", { feature: featureTitle(k, t) });
    case "terminal":
      return t("ui-contracts.feature.fix.terminal");
    default:
      return t("ui-contracts.feature.fix.default", { other, terminal });
  }
}

/**
 * The hook for a generic ACP harness (P4-10): a config entry's declared
 * optional capabilities (absent = none) and its read-only mode value →
 * the same report the native adapters make, so every route (askOnly,
 * rewind, settings, steer …) and `featuresFor` read it unchanged. The
 * Runner puts it under `agentFeatures[<entry id>]`.
 */
export interface HarnessDeclaration {
  features?: Partial<Record<OptionalFeature, Support>>;
  /** The permission mode value that counts as read-only (null: none). */
  readOnlyMode?: string | null;
  /** D-28: `plan`-like modes are `weak` (the default). */
  readOnlyStrength?: "strong" | "weak";
}
export function declareCapabilities(
  agent: string,
  d: HarnessDeclaration = {},
  cliVersion?: string,
): AgentCapabilities {
  const f: Partial<Record<OptionalFeature, Support>> = {};
  for (const k of OPTIONAL_FEATURES) f[k] = sup(d.features?.[k]);
  const fallback = { support: "fallback" as const };
  const apply = (s: Support) =>
    (s === "native" ? "native" : "restart") as "native" | "restart";
  return {
    version: 1,
    agent,
    input: {
      steer:
        f.steer === "native"
          ? {
              support: "native",
              opts: {
                ack: ["received"],
                boundary: "tool",
                images: false,
                slashCommands: false,
              },
            }
          : (fallback as AgentCapabilities["input"]["steer"]),
      withdraw: { support: f.withdraw === "native" ? "native" : "none" },
      afterTurn: fallback,
      jump: {
        support: f.steer === "native" ? "native" : "fallback",
        opts: { interrupts: false },
      },
    },
    settings: {
      model: apply(f.model!),
      effort: apply(f.effort!),
      permissionMode: apply(f.permissionMode!),
    },
    approvals: {
      autoReviewDenials: { support: "none" },
      approveDenied: fallback,
    },
    background: {
      list: { support: f.background === "native" ? "native" : "fallback" },
      stop: { support: f.background === "native" ? "native" : "fallback" },
    },
    askOnly: { sideQuestion: "none", fork: f.askOnly! },
    rewind: { history: f.rewind!, files: f.rewindFiles! },
    title: { generate: "none", sync: "none" },
    modelSwitch: { support: "none" },
    features: {
      session: "native",
      stream: "native",
      cancel: "native",
      approvals: "native",
      ...f,
    },
    readOnly: d.readOnlyMode
      ? {
          support: "native",
          via: `mode ${d.readOnlyMode}`,
          opts: {
            strength: d.readOnlyStrength ?? "weak",
            mode: d.readOnlyMode,
          },
        }
      : { support: "none" },
    ...(cliVersion ? { cliVersion } : {}),
  };
}
