/** Authenticated Claude hook and transcript fixtures for user activity (PRD §5.4). */
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ElwoodActivityEvent, type StartClaudeOptions, startClaude } from "../../src/index.ts";
import { emptyComposer } from "../fixtures/owned-turn/composer.ts";
import { installFakes, ptys, tempDir } from "./helpers.ts";

const nativeClaudeSessionId = "claude-native";

export function user(promptId: string, content: unknown) {
  return { type: "user", uuid: `user-${promptId}`, promptId, message: { content } };
}

export async function startActivitySession(options: Omit<StartClaudeOptions, "cwd"> = {}) {
  installFakes();
  const cwd = tempDir();
  const transcript = join(cwd, "transcript.jsonl");
  writeFileSync(transcript, "");
  const session = await startClaude({ ...options, cwd });
  const events: ElwoodActivityEvent[] = [];
  session.on("activity", (event) => events.push(event));
  return {
    session,
    events,
    transcript,
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

export async function startPromptActivitySession(options: Omit<StartClaudeOptions, "cwd"> = {}) {
  const { session, hook, events, append } = await startActivitySession(options);
  const pty = ptys.at(-1)!;
  const paint = async () => {
    pty.emitData(emptyComposer("claude"));
    await session.terminal.settled();
  };
  await hook({
    hook_event_name: "InstructionsLoaded",
    file_path: "/tmp/CLAUDE.md",
    memory_type: "Project",
    load_reason: "session_start",
  });
  await paint();
  return {
    session,
    hook,
    pty,
    paint,
    append,
    messages: () => events.filter((event) => event.kind === "user_message"),
    submit: (prompt: string | undefined, prompt_id?: string) =>
      hook({ hook_event_name: "UserPromptSubmit", prompt, prompt_id }),
  };
}
