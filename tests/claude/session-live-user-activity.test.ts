/** Claude only repairs a blank prompt from a directly matched committed user record (PRD §5.4). */
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { type ElwoodActivityEvent, startClaude } from "../../src/index.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

function user(promptId: string, content: unknown) {
  return { type: "user", uuid: `user-${promptId}`, promptId, message: { content } };
}

async function startActivitySession() {
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
        session_id: "claude-native",
        cwd,
        transcript_path: transcript,
        ...fields,
      }),
    append: (...items: unknown[]) =>
      appendFileSync(transcript, `${items.map((item) => JSON.stringify(item)).join("\n")}\n`),
  };
}

test("C-API-63 repairs an earlier blank hook once the matched text commits", async () => {
  const { session, hook, events, append } = await startActivitySession();
  const submit = (prompt_id: string, prompt?: string) =>
    hook({
      hook_event_name: "UserPromptSubmit",
      prompt_id,
      ...(prompt === undefined ? {} : { prompt }),
    });
  try {
    append(user("historical", "old conversation"), user("baseline", "unmatched prior turn"));
    await hook({ hook_event_name: "SessionStart", source: "startup" });
    await session.sendPrompt("submitted from API");
    expect(await submit("first")).toMatchObject({ exitCode: 0 });
    expect(events).toContainEqual(
      expect.objectContaining({ kind: "hook", hookEventName: "UserPromptSubmit", turnId: "first" }),
    );
    expect(events.filter(({ kind }) => kind === "user_message")).toEqual([]);
    await submit("historical", "\n");
    await submit("next", "neighbor hook prompt");
    append(
      user("wrong", "different transcript prompt"),
      user("first", [{ type: "tool_result", tool_use_id: "tool", content: "tool output" }]),
      user("first", [{ type: "text", text: "submitted from API" }]),
      user("first", "duplicate record"),
      user("next", "neighbor hook prompt"),
    );
    await hook({ hook_event_name: "Stop" });
    await submit("first", "submitted from API");
    expect(events.filter(({ kind }) => kind === "user_message")).toMatchObject([
      { text: "neighbor hook prompt", turnId: "next", source: "hook" },
      { text: "submitted from API", turnId: "first", source: "transcript" },
    ]);
  } finally {
    await session.teardown();
  }
});
