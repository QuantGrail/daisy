/**
 * unified semantics Claude Code does natively on a live process
 * (contracts agent-capabilities.ts `askOnly` / `rewind`), measured on
 * Claude Code 2.1.316 (`-p --input-format stream-json`):
 *
 *  - control `side_question {question, history:[{question, response}]}`
 *    answers from the conversation in memory with no tools, while a turn
 *    runs or not, without interrupting it and without entering its
 *    history; two at once both answer. The answer is
 *    `{response: string | null, synthetic: boolean}` (synthetic / null: no
 *    real answer). The CLI's own deadline is 660 s; Daisy waits less and
 *    then sends `control_cancel_request {request_id}` (also on 「停止」).
 *  - control `rewind_conversation {target_message_uuid}` removes that user
 *    message and everything after it, in place (same session id); answers
 *    `{rewound: true, prefillText, …}` or `{rewound: false, reason}`
 *    (`target_not_found`, `turn_running` …). The uuid Daisy gave the
 *    stdin message is the one it takes.
 *  - control `rewind_files {user_message_id, dry_run}` restores the files
 *    Claude's own edit tools (Write / Edit) changed since that message —
 *    not what a Bash command changed — and only when the process was
 *    started with CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING (agentEnv);
 *    otherwise `{canRewind: false, error: "File rewinding is not enabled."}`.
 *    A dry run answers `{canRewind, filesChanged, insertions, deletions}`.
 */
import { turnT } from "./model-switch.ts";
import { randomUUID } from "node:crypto";
import type { JsonProcess } from "../turns/transport.ts";
import type { RewindFiles, RewindOutcome } from "./shared.ts";

/**
 * One side question on process `p`; null when there is no real answer
 * (an error, an older CLI that does not know the request, a synthetic
 * "no answer", Daisy's own deadline or the job stopped).
 */
export async function askSideQuestion(
  p: JsonProcess,
  question: string,
  history: { question: string; response: string }[],
  o: { signal: AbortSignal; timeoutMs: number },
): Promise<string | null> {
  if (o.signal.aborted) return null;
  const id = randomUUID();
  let gaveUp = false;
  let stop = () => {};
  const stopped = new Promise<null>(
    (r) =>
      (stop = () => {
        gaveUp = true;
        r(null);
      }),
  );
  o.signal.addEventListener("abort", stop, { once: true });
  try {
    const r: any = await Promise.race([
      p
        .control(
          {
            subtype: "side_question",
            question,
            history: history.map((h) => ({
              question: String(h.question || ""),
              response: String(h.response || ""),
            })),
          },
          o.timeoutMs,
          id,
        )
        .catch((e: Error) => {
          // Daisy's own deadline: the CLI is told to give the run up.
          if (/protocol timeout/i.test(e?.message || "")) gaveUp = true;
          return null;
        }),
      stopped,
    ]);
    if (!r || typeof r.response !== "string" || r.synthetic !== false)
      return null;
    return r.response.trim() || null;
  } finally {
    o.signal.removeEventListener("abort", stop);
    // Stopped or past Daisy's deadline: cancel the side question in the
    // CLI (it would otherwise run on to its own 660 s deadline).
    if (gaveUp)
      try {
        p.send({ type: "control_cancel_request", request_id: id });
      } catch {
        // The process is gone: nothing to cancel.
      }
  }
}

/**
 * 「回退」 in place on process `p` (idle): the files first when asked (dry
 * run, then the real one — while the message is still in the
 * conversation), then the conversation. `inPlace: false`: the CLI did not
 * rewind the conversation — the caller copies it instead; what
 * happened to the files is reported either way.
 */
export async function rewindInPlace(
  p: JsonProcess,
  sessionId: string,
  uuid: string,
  o: { files: boolean },
): Promise<RewindOutcome> {
  let files: RewindFiles = { reverted: false, reason: "not-asked" };
  if (o.files) {
    const dry: any = await p
      .control(
        { subtype: "rewind_files", user_message_id: uuid, dry_run: true },
        15_000,
      )
      .catch((e: Error) => ({ canRewind: false, error: e.message }));
    if (dry?.canRewind === true) {
      const changed = Array.isArray(dry.filesChanged)
        ? dry.filesChanged.map(String).slice(0, 200)
        : [];
      if (!changed.length) files = { reverted: false, reason: "nothing" };
      else {
        const done: any = await p
          .control({ subtype: "rewind_files", user_message_id: uuid }, 30_000)
          .catch((e: Error) => ({ canRewind: false, error: e.message }));
        files =
          done?.canRewind === true
            ? {
                reverted: true,
                filesChanged: changed,
                ...(typeof dry.insertions === "number"
                  ? { insertions: dry.insertions }
                  : {}),
                ...(typeof dry.deletions === "number"
                  ? { deletions: dry.deletions }
                  : {}),
              }
            : {
                reverted: false,
                reason: String(done?.error || turnT()("server-harness.claudeNative.rewindFailed")).slice(0, 300),
              };
      }
    } else
      files = {
        reverted: false,
        reason: String(dry?.error || turnT()("server-harness.claudeNative.noSnapshot")).slice(0, 300),
      };
  }
  const r: any = await p
    .control(
      { subtype: "rewind_conversation", target_message_uuid: uuid },
      15_000,
    )
    .catch(() => null);
  if (r?.rewound !== true)
    return {
      sessionId,
      inPlace: false,
      files,
      ...(r?.reason || r?.error
        ? { refused: String(r.reason || r.error).slice(0, 200) }
        : {}),
    };
  return {
    sessionId,
    inPlace: true,
    ...(typeof r.prefillText === "string"
      ? { prefillText: r.prefillText }
      : {}),
    files,
  };
}
