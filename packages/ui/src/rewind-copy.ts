import { featuresFor, normalizeSupport } from "@daisy-ai/contracts";
import { t } from "./i18n";
/**
 * 「回退」 wording, shared by Web and native: the edit-and-resend
 * banner and its 「同时撤销文件」 toggle. Claude Code restores
 * files natively (`rewind_files`, its live process; only what its own
 * edit tools changed); Codex by Daisy's per-turn checkpoints
 * (what its edit tool changed goes back whole to its content before the
 * turn, others' edits to it in that turn too; a file changed since, or a
 * turn without a checkpoint, refuses the rewind).
 * The snapshot's `rewindFiles` says which (absent: an older server —
 * Claude Code only).
 */
export const REWIND_WORDS = {
  get filesToggle() {
    return t("ui-queue.rewind.filesToggle");
  },
  get filesToggleOn() {
    return t("ui-queue.rewind.filesToggleOn");
  },
};

export type RewindFilesSupport = "native" | "fallback" | "none";
/**
 * How files are restored for `agent` (`reported`: the snapshot's
 * `rewindFiles`; ADR-152: an older server's `"harbor"` is `"fallback"`).
 */
export const rewindFilesSupport = (
  agent: string | undefined,
  reported?: RewindFilesSupport | "harbor" | null,
): RewindFilesSupport => {
  const r = normalizeSupport(reported);
  return r === "native" || r === "fallback" || r === "none"
    ? r
    : // P4-11: this release's declaration (Claude Code natively).
      featuresFor(null, agent || "").rewindFiles;
};
/** The agent can restore files on 「回退」 (offered as a toggle). */
export const canRewindFiles = (
  agent: string | undefined,
  reported?: RewindFilesSupport | "harbor" | null,
) => rewindFilesSupport(agent, reported) !== "none";

/** The edit banner: what sending does to the history and to the files. */
export function editBannerText(
  agent: string | undefined,
  files: boolean,
  reported?: RewindFilesSupport | "harbor" | null,
) {
  const how = rewindFilesSupport(agent, reported);
  if (how === "fallback" && files) return t("ui-queue.rewind.edit.fallbackFiles");
  if (how === "native" && files) return t("ui-queue.rewind.edit.nativeFiles");
  return t("ui-queue.rewind.edit.noFiles");
}

/**
 * N-7 (C-1 device acceptance): the /rewind panel's text — what the rewind
 * does to the conversation and, with 「同时撤销文件」, which files it
 * restores (only what the AI's edit tools changed; the same rules as the
 * edit banner above).
 */
export function rewindPanelText(
  agent: string | undefined,
  files: boolean,
  reported?: RewindFilesSupport | "harbor" | null,
) {
  const how = rewindFilesSupport(agent, reported);
  if (how === "none") return t("ui-queue.rewind.panel.unsupported");
  if (!files) return t("ui-queue.rewind.panel.noFiles", { toggle: REWIND_WORDS.filesToggle });
  if (how === "fallback") return t("ui-queue.rewind.panel.fallbackFiles");
  return t("ui-queue.rewind.panel.nativeFiles");
}
