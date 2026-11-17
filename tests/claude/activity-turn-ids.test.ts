/** Native Claude prompt identities survive delayed transcript delivery (PRD §5.4). */
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import type { ElwoodActivityEvent } from "../../src/core/activity/index.ts";
import { startClaude } from "../../src/index.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

test("C-CLAUDE-15 a late reply retains the user turn after ready and its successor", async () => {
  installFakes();
  const cwd = tempDir();
  const transcript = join(cwd, "turns.jsonl");
  writeFileSync(transcript, "");
  const session = await startClaude({ cwd });
  const events: ElwoodActivityEvent[] = [];
  session.on("activity", (event) => events.push(event));
  const hook = (fields: Record<string, unknown>) =>
    ptys[0]!.dispatchHook(session.elwoodSessionId, {
      session_id: "claude-native",
      cwd,
      transcript_path: transcript,
      ...fields,
    });
  const append = (...records: unknown[]) =>
    appendFileSync(transcript, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
  try {
    await hook({ hook_event_name: "SessionStart", source: "startup" });
    await session.sendPrompt("first");
    await hook({ hook_event_name: "UserPromptSubmit", prompt_id: "turn-a", prompt: "first" });
    append(
      { type: "user", uuid: "user-a", promptId: "turn-a", message: { content: "first" } },
      {
        type: "assistant",
        uuid: "partial-a",
        parentUuid: "user-a",
        message: { content: [{ type: "thinking", thinking: "planning" }] },
      },
    );
    await hook({ hook_event_name: "Stop" });
    expect(session.status).toBe("ready");
    await session.sendPrompt("second");
    await hook({ hook_event_name: "UserPromptSubmit", prompt_id: "turn-b", prompt: "second" });
    append(
      {
        type: "user",
        uuid: "user-b",
        parentUuid: "partial-a",
        promptId: "turn-b",
        message: { content: "second" },
      },
      {
        type: "assistant",
        uuid: "final-a",
        parentUuid: "partial-a",
        message: { content: [{ type: "text", text: "late first reply" }] },
      },
      {
        type: "assistant",
        uuid: "final-b",
        parentUuid: "user-b",
        message: { content: [{ type: "text", text: "second reply" }] },
      },
      { type: "assistant", message: { content: [{ type: "text", text: "unlinked reply" }] } },
    );
    await hook({ hook_event_name: "Stop" });
    expect(
      events.filter((event) => event.kind === "user_message").map((event) => event.turnId),
    ).toEqual(["turn-a", "turn-b"]);
    expect(events.filter((event) => event.kind === "reasoning")).toMatchObject([
      { turnId: "turn-a" },
    ]);
    expect(events.filter((event) => event.kind === "assistant_message")).toMatchObject([
      { text: "late first reply", turnId: "turn-a" },
      { text: "second reply", turnId: "turn-b" },
      { text: "unlinked reply" },
    ]);
    expect(events.find((event) => event.text === "unlinked reply")?.turnId).toBeUndefined();
  } finally {
    await session.teardown();
  }
});
