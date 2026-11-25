/** Native Claude prompt identities survive delayed transcript delivery (PRD §5.4). */
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import type { ElwoodActivityEvent } from "../../src/core/activity/index.ts";
import { startClaude } from "../../src/index.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

test("C-API-64 a late final reply retains the user turn after ready and its successor", async () => {
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
        message: {
          stop_reason: "end_turn",
          content: [
            { type: "text", text: "late first reply" },
            { type: "text", text: "final first block" },
            { type: "text", text: "" },
            { type: "thinking", thinking: "extra reasoning" },
          ],
        },
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
    expect(
      events
        .filter((event) => event.kind === "reasoning" || event.kind === "assistant_message")
        .map(({ kind, text, turnId, final }) => ({ kind, text, turnId, final })),
    ).toEqual([
      { kind: "reasoning", text: "planning", turnId: "turn-a", final: undefined },
      { kind: "assistant_message", text: "late first reply", turnId: "turn-a", final: undefined },
      { kind: "assistant_message", text: "final first block", turnId: "turn-a", final: true },
      { kind: "reasoning", text: "extra reasoning", turnId: "turn-a", final: undefined },
      { kind: "assistant_message", text: "second reply", turnId: "turn-b", final: undefined },
      { kind: "assistant_message", text: "unlinked reply", turnId: undefined, final: undefined },
    ]);
  } finally {
    await session.teardown();
  }
});

test("C-API-64 native Claude subagent path withholds finality without a sidechain flag", async () => {
  installFakes();
  const cwd = tempDir();
  const transcript = join(cwd, "main.jsonl");
  const agentTranscript = join(cwd, "agent.jsonl");
  writeFileSync(transcript, "");
  const agentRows = [
    { type: "user", message: { content: "Check the fixture" } },
    { type: "assistant", message: { content: "Subagent reply", stop_reason: "end_turn" } },
  ];
  writeFileSync(agentTranscript, `${agentRows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  const session = await startClaude({ cwd });
  const replies: ElwoodActivityEvent[] = [];
  session.on("activity", (event) => {
    if (event.kind === "assistant_message") replies.push(event);
  });
  try {
    await ptys[0]!.dispatchHook(session.elwoodSessionId, {
      hook_event_name: "SubagentStop",
      session_id: "claude-native",
      cwd,
      transcript_path: transcript,
      agent_transcript_path: agentTranscript,
      agent_type: "general-purpose",
      agent_id: "test-agent",
    });
    expect(replies).toMatchObject([{ text: "Subagent reply", transcriptPath: agentTranscript }]);
    expect(replies[0]).not.toHaveProperty("final");
  } finally {
    await session.teardown();
  }
});
