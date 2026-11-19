/**
 * The workspace notes the Runner adds to a turn: a shared-edit
 * workspace, or a read-only / snapshot one (the same words as the layered
 * prompt's). P1-01: the 群聊 CLI's per-turn note that lived here went with
 * the CLI; stage 4 adds the A2A tools' note (plan 6.2). P6-24: in the
 * session's language.
 */
import "./lang.ts";
import { readOnlyText, sharedWorkspaceText } from "../../../contracts/src/guide.ts";
import type { PromptT } from "../../../contracts/src/prompt-i18n.ts";
/**
 * Shared-edit workspaces only: read-only and isolated sessions
 * get their own line already.
 */
export const sharedWorkspaceNote = (t: PromptT) => "\n" + sharedWorkspaceText(t);
/** Read-only / snapshot sessions (the same words as the layered prompt's). */
export const readOnlyNote = (t: PromptT) => "\n" + readOnlyText(t);
