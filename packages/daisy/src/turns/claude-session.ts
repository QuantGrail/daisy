// Separate process: the selected identity's environment never changes the Runner's environment.
import { turnT } from "../harness/model-switch.ts";
import {
  forkSession,
  getSessionMessages,
} from "@anthropic-ai/claude-agent-sdk";
let raw = "";
for await (const chunk of process.stdin) raw += chunk;
const { sessionId, cwd, count, beforeUuid, title } = JSON.parse(raw);
if (typeof sessionId !== "string" || typeof cwd !== "string")
  throw Error("Invalid session");
let upToMessageId: string | undefined;
if (count) {
  const messages = await getSessionMessages(sessionId, { dir: cwd });
  // Edit and resend: the prompt's own uuid locates the cut exactly;
  // counting user messages would also count task notifications and steers.
  // Older prompts carry no uuid and fall back to counting; a uuid that is
  // gone from the transcript is an error, never a guess.
  let cutoff: number | undefined =
    typeof beforeUuid === "string"
      ? messages.findIndex((m: any) => m.uuid === beforeUuid)
      : -1;
  if (typeof beforeUuid === "string" && cutoff < 0)
    throw Error(
      turnT()("server-turns.rewind.messageNotFound"),
    );
  if (cutoff < 0) {
    const users = messages
      .map((m, i) => ({ m, i }))
      .filter(
        ({ m }: any) =>
          m.type === "user" &&
          !(
            Array.isArray(m.message?.content) &&
            m.message.content.every((c: any) => c.type === "tool_result")
          ),
      );
    cutoff = users[users.length - count]?.i;
  }
  if (cutoff === undefined) throw Error(turnT()("server-turns.rewind.tooMany"));
  if (cutoff === 0) {
    console.log(JSON.stringify({ reset: true }));
    process.exit(0);
  }
  upToMessageId = messages[cutoff - 1].uuid;
}
console.log(
  JSON.stringify(
    await forkSession(sessionId, {
      dir: cwd,
      ...(upToMessageId ? { upToMessageId } : {}),
      // Daisy's title, or a marker the title sync ignores (the SDK
      // writes a custom title on every fork).
      title:
        typeof title === "string" && title
          ? title
          : count
            ? "Daisy rewind"
            : "Daisy fork",
    }),
  ),
);
