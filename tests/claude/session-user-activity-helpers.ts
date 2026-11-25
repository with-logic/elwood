/** Authenticated Claude hook and transcript fixtures for user activity (PRD §5.4). */
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ElwoodActivityEvent, startClaude } from "../../src/index.ts";
import { installFakes, ptys, tempDir } from "./helpers.ts";

const nativeClaudeSessionId = "claude-native";

export function user(promptId: string, content: unknown) {
  return { type: "user", uuid: `user-${promptId}`, promptId, message: { content } };
}

export async function startActivitySession() {
  installFakes();
  const cwd = tempDir();
  const transcript = join(cwd, "transcript.jsonl");
  writeFileSync(transcript, "");
  const session = await startClaude({ cwd });
  const events: ElwoodActivityEvent[] = [];
  session.on("activity", (event) => events.push(event));
  return {
    session,
    events,
    hook: (fields: Record<string, unknown>) =>
      ptys.at(-1)!.dispatchHook(session.elwoodSessionId, {
        session_id: nativeClaudeSessionId,
        cwd,
        transcript_path: transcript,
        ...fields,
      }),
    append: (...items: unknown[]) =>
      appendFileSync(transcript, `${items.map((item) => JSON.stringify(item)).join("\n")}\n`),
  };
}
