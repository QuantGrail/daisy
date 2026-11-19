import { z } from "zod";
// Browsers run the app under a strict CSP (no 'unsafe-eval'); zod's JIT probe
// (`new Function`) would otherwise log a CSP violation on first parse.
if (typeof document !== "undefined") z.config({ jitless: true });
// P0-06: the product's names, one place.
export * from "./names.ts";
// P6-20 (ADR-159): language packs (the text itself is in ../locales).
export * from "./i18n.ts";
export * from "./prompt-i18n.ts";
// P6-28: Daisy's own default names, said in the reader's language.
export * from "./default-names.ts";
// P6-03 (ADR-153): DAISY_* environment variables, HARBOR_* still read.
export * from "./env.ts";
export { buildPrompt } from "./prompt.ts";
export * from "./title.ts";
export * from "./agent-label.ts";
// P4-10: the ACP harness table (one entry per harness).
export * from "./acp-harnesses.ts";
export * from "./restart.ts";
export * from "./context-usage.ts";
export * from "./model-options.ts";
export * from "./scheduler.ts";
export * from "./resident-prompt.ts";
export * from "./guide.ts";
export * from "./native-tools.ts";
export * from "./notifications.ts";
// P1-00: the contracts by domain; this file stays the one public entry.
export * from "./session.ts";
export * from "./items.ts";
export * from "./message.ts";
export * from "./queue.ts";
export * from "./live.ts";
export * from "./profile.ts";
export * from "./workspace.ts";
export * from "./node.ts";
export * from "./user.ts";
export * from "./runner-job.ts";
export * from "./branding.ts";
// docs/contracts/limits.md (P1-05 starts it with the PIN rows).
export * from "./limits.ts";
// P4-04: the A2A 1.0 wire shapes (a2a-usage.md).
export * from "./a2a.ts";
// P2-03: the event outlet's shapes (docs/contracts/events.md, shared).
export * from "./events.ts";
export const API_VERSION = 1;

export {
  commonCommands,
  commandList,
  commandOffered,
  COMMAND_FEATURES,
} from "./commands";
// P4-11 (§5.5): the flat capability map the UI and the command line read.
export * from "./agent-features.ts";
export type { AgentCommand, AgentOperation } from "./commands";

export * from "./approvals.ts";
export * from "./ask-sidecar.ts";

// P1-06 (ADR-107): the local API's one table — routes, command-line
// metadata, docs. The definitions themselves stay under `api.*`.
export {
  api,
  API_ROUTES,
  API_GROUPS,
  findRoute,
  fillPath,
  pathParams,
  isExempt,
  cliCommandOf,
  cliCommands,
  cliExemptions,
  LOCAL_COMMANDS,
  OWNER_CHANNELS,
  SCOPES,
  EventsQuerySchema,
  secretInput,
  fileInput,
  cliTree,
  cliHelp,
  apiMarkdown,
  apiOpenApi,
  EXTERNAL_GATES,
  // P1-05: the PIN's header, rule and shapes.
  PIN_GRANT_HEADER,
  normalizePin,
  pinRuleError,
  PinStatusSchema,
  PinSetBodySchema,
  PinGrantBodySchema,
  PinGrantSchema,
  PIN_VIA,
  // P4-02: 「放别人进来」 kinds, their places, what a PIN reset takes back.
  LET_IN,
  LET_IN_KINDS,
  LET_IN_WORDS,
  LET_IN_GROUPS,
  letInKindsOfPath,
  pathWords,
  REVOCATIONS,
  REVOCATION_KINDS,
  letInKindsAt,
  letsSomeoneIn,
  letInProblems,
  // D-40 ①: the PIN on some channels only.
  PIN_ON_CLI,
  pinFor,
  // P6-23a (ADR-159 §7): a route's text in a language.
  routeText,
  routeTextKey,
  describedText,
  exemptText,
  groupTitle,
  localizeSchema,
  fieldText,
  limitsText,
  API_TEXT_PARAMS,
} from "./api/index.ts";
export {
  HARNESS_CONFIG_OPERATIONS,
  SESSION_OPERATION_NAMES,
  TERMINAL_OPERATION,
} from "./api/operations.ts";
export type {
  AnyRoute,
  RouteDef,
  Scope as ApiScope,
  Channel as ApiChannel,
  OwnerChannel as ApiOwnerChannel,
  AuthMode as ApiAuthMode,
  ExternalGate,
  ApiGroup,
  ApiInput,
  ApiOutput,
  ApiBody,
  ApiQuery,
  ApiParams,
  CliCommandMeta,
  CliParam,
  CliNode,
  AuditRecord,
  AuditPage,
  AuditActor,
  LogLineOut,
  NotificationsPage,
  PinStatus,
  PinVia,
  LetInKind,
  RevocationKind,
} from "./api/index.ts";
export type { AccessStatus } from "./api/access.ts";
// P6-20 (ADR-159): the display language setting.
export { LanguageViewSchema, type LanguageView } from "./api/settings.ts";
// P5-03 (ADR-142): paired devices, pairing codes, device sessions.
export type { Device, PairingCode, PairLock, DeviceSession } from "./api/devices.ts";
export type { RelayStatus } from "./api/relay.ts";
// P4-06 (ADR-125): a session as a public agent; what making it public means.
export type { SessionPublic, AgentAskAct } from "./api/invoke.ts";
export { crossTalkNote } from "./api/invoke.ts";
// P4-12 (ADR-132): what the 「对外」 pages show.
export type { InvokeRequest, InvokeGrant, InvokePerson, AgentAudience } from "./api/invoke.ts";
export type { Contact, IdentityCardView, CardInspection, ContactImportResult } from "./api/contacts.ts";
export type { ResidentAgentView, ResidentConversation } from "./api/residents.ts";
export { RESIDENT_LAYERS, RESIDENT_APPROVALS, RESIDENT_AGENT_LIMITS } from "./api/residents.ts";
export type { VisitorToken } from "./api/tokens.ts";
export type { OutgoingCall, AgentOverview } from "./api/outgoing.ts";
