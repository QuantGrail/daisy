/**
 * P1-06 (ADR-107): the local API's one table. A new route is one entry in
 * one of these files; the server registers it from here (packages/daisy
 * `serve`), and the docs (scripts/gen-api-docs.ts), the command-line
 * metadata (cli.ts) and the client's types (`client.call`) follow.
 */
import type { AnyRoute, ApiGroup } from "./route.ts";
import { sessions } from "./sessions.ts";
import { messages } from "./messages.ts";
import { operations } from "./operations.ts";
import { sessionTools } from "./session-tools.ts";
import { prompts, sessionPrompts } from "./prompts.ts";
import { approvals } from "./approvals.ts";
import { profiles } from "./profiles.ts";
import { workspaces } from "./workspaces.ts";
import { settings } from "./settings.ts";
import { pin } from "./pin.ts";
import { attachments } from "./attachments.ts";
import { system } from "./system.ts";
import { access } from "./access.ts";
import { issuer } from "./issuer.ts";
import { aiTokens } from "./ai-token.ts";
import { audit } from "./audit.ts";
import { notifications } from "./notifications.ts";
import { events } from "./events.ts";
import { contacts } from "./contacts.ts";
import { invoke } from "./invoke.ts";
export * from "./residents.ts";
import { residents } from "./residents.ts";
import { a2a } from "./a2a.ts";
import { tokens } from "./tokens.ts";
import { outgoing, agents } from "./outgoing.ts";
import { devices } from "./devices.ts";
import { relay, tlsBinding } from "./relay.ts";

export * from "./route.ts";
export * from "./text-params.ts";
export * from "./let-in.ts";
export * from "./schema-info.ts";
export * from "./cli.ts";
export * from "./docs.ts";
export { IssuerSetSchema, type IssuerStatus } from "./issuer.ts";
export { LanguageViewSchema, type LanguageView } from "./settings.ts";
export { UiOriginsSchema, type UiOriginsStatus } from "./access.ts";
export { RelaySetSchema, RELAY_ADDRESS_HINT, type RelayStatus } from "./relay.ts";
export { AiTokenBodySchema, type AiToken } from "./ai-token.ts";
export * from "./audit.ts";
export type { NotificationsPage } from "./notifications.ts";
export { EventsQuerySchema } from "./events.ts";
export {
  ContactImportSchema,
  ContactInspectSchema,
  CardExportQuery,
  type CardAddress,
  type CardInspection,
  type Contact,
  type ContactImportResult,
  type IdentityCardView,
} from "./contacts.ts";
export {
  INVOKE_DECISIONS,
  InvokeDecideSchema,
  AudienceSetSchema,
  type InvokeDecisionKey,
  type InvokePerson,
  type InvokeRequest,
  type InvokeGrant,
  type AgentAudience,
  AskActSetSchema,
  PublicSetSchema,
  crossTalkNote,
  type AgentAskAct,
  type SessionPublic,
} from "./invoke.ts";
export { TokenIssueSchema, ttlSeconds, type VisitorToken } from "./tokens.ts";
export type { OutgoingCall, AgentOverview } from "./outgoing.ts";
export {
  PairBodySchema,
  PairRedeemSchema,
  DeviceSessionSchema,
  type Device,
  type PairingCode,
  type DeviceSession,
} from "./devices.ts";
export {
  PIN_GRANT_HEADER,
  normalizePin,
  pinRuleError,
  PinStatusSchema,
  PinSetBodySchema,
  PinGrantBodySchema,
  PinGrantSchema,
  PIN_VIA,
  type PinStatus,
  type PinVia,
} from "./pin.ts";

/** Every route, by the file it is defined in: `api.sessions.create`. */
export const api = {
  sessions,
  messages,
  operations,
  sessionTools,
  sessionPrompts,
  prompts,
  approvals,
  profiles,
  workspaces,
  settings,
  pin,
  attachments,
  system,
  access,
  issuer,
  aiTokens,
  audit,
  notifications,
  events,
  contacts,
  invoke,
  residents,
  // P4-12 (ADR-132): daisy token, my agents, my AIs' calls.
  agents,
  tokens,
  outgoing,
  // P5-03 (ADR-142): pairing the owner's other devices.
  devices,
  // P5-02 (ADR-144): the relay, and the TLS binding claim.
  relay,
  tlsBinding,
  a2a,
};

/**
 * The groups in docs / help order (5.10). Their one-line titles are the
 * packs' `api.group.<id>` (P6-23a, route.ts `groupTitle`).
 */
export const API_GROUPS: readonly { id: ApiGroup }[] = [
  { id: "session" },
  { id: "approval" },
  { id: "profile" },
  { id: "workspace" },
  { id: "grant" },
  { id: "settings" },
  { id: "attachment" },
  { id: "system" },
  { id: "events" },
  { id: "a2a" },
];

/** All definitions, flat, in table order. */
export const API_ROUTES: readonly AnyRoute[] = Object.values(api).flatMap(
  (g) => Object.values(g as Record<string, AnyRoute>),
);

/** The definition of `METHOD path` (path as registered, with `:params`). */
export function findRoute(method: string, path: string): AnyRoute | undefined {
  return API_ROUTES.find((r) => r.method === method && r.path === path);
}
