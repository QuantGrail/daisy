/**
 * P4-13 (ADR-129): what a plugin package may import from Daisy — the one
 * public entry `@daisy-ai/daisy/plugin`. A plugin lives in its own package
 * (any name the owner writes — P6-16, ADR-160 —, exports `./server` and
 * `./runner`), is loaded only by name (plugins/runner.ts `pluginPackage`,
 * `importPlugin`) and reaches the core only
 * through this module: the two halves' interfaces, and the few helpers a
 * plugin needs to log, find the owner, wake a session (and name its
 * callbacks) and quote outside text. P6-14: the shape of the notification
 * kinds a plugin declares (`NotificationKindDecl`, hook 3). Nothing in the core imports a plugin.
 */
export type {
  DaisyServerPlugin,
  EventHost,
  JobBookkeeping,
  OrgCoreSource,
  ServerPluginHost,
  ServerPluginModule,
  WakeStopped,
} from "./server.ts";
export type {
  DaisyRunnerPlugin,
  RunnerPluginHost,
  RunnerPluginModule,
} from "./runner.ts";
export type { Store } from "../store/index.ts";
export type { Scheduler } from "../schedule/scheduler.ts";
export type {
  NotificationKind,
  NotificationKindDecl,
  NotificationKindId,
  PluginText,
  Session,
} from "../../../contracts/src/index.ts";
export { log } from "../observe/log.ts";
export { OWNER_ID, ownerUser } from "../access/owner.ts";
export { clean } from "../prompts/source-prompt.ts";
export { residentHeld } from "../../../contracts/src/scheduler.ts";
/**
 * P6-12 (ADR-157): the scheduleId of a plugin's callback wake
 * (`callback[-human]:<kind>:<item id>`; the kinds and id shapes are the
 * plugin's, the frame the core's).
 */
export { callbackScheduleId } from "../schedule/callback-jobs.ts";
export {
  GUIDE_LIMITS,
  looksLikeOrgCore,
  type OrgGuideRecord,
  type OrgReadReason,
} from "../../../contracts/src/guide.ts";
