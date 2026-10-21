/** Public hook IPC cannot acknowledge a different native question request (C-QUESTION-02/03). */
import { afterEach, expect, test } from "vitest";
import { type ClaudeSessionApi, startClaude } from "../../src/index.ts";
import { fixture } from "../unit/questions/helpers.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

const sessions: ClaudeSessionApi[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.kill();
  resetFakes();
});
const question = {
  question: "Which test note?",
  header: "Note",
  multiSelect: false,
  options: [
    { label: "Brief (short)", description: "A short test note." },
    { label: "Detailed (long)", description: "A long test note." },
  ],
};
test("C-QUESTION-03 unrelated and prior ID-less completions cannot settle public answers", async () => {
  installFakes();
  const cwd = tempDir();
  const session = await startClaude({ cwd, initialSize: { cols: 140, rows: 45 } });
  sessions.push(session);
  const pty = ptys[0]!;
  await pty.dispatchHook(session.elwoodSessionId, {
    hook_event_name: "InstructionsLoaded",
    session_id: "native",
    cwd,
    file_path: "/tmp/CLAUDE.md",
    memory_type: "Project",
    load_reason: "session_start",
  });
  const hook = (name: string, fields: Record<string, unknown>) =>
    pty.dispatchHook(session.elwoodSessionId, {
      hook_event_name: name,
      session_id: "native",
      cwd,
      tool_name: "AskUserQuestion",
      tool_input: { questions: [question] },
      ...fields,
    });
  const show = async (prompt: string) => {
    const native = fixture("freeform-questions");
    pty.emitData(
      `\x1b[H\x1b[2J${native.lines.map((line) => line.replaceAll(question.question, prompt)).join("\r\n")}\x1b[${native.cursorRow + 1};1H`,
    );
    await session.terminal.settled();
  };
  await hook("PreToolUse", { tool_use_id: "old" });
  await show(question.question);
  const [previous] = await session.listQuestions();
  const replacement = { ...question, question: "Which replacement note?" };
  await hook("PreToolUse", { tool_use_id: "current", tool_input: { questions: [replacement] } });
  await show(replacement.question);
  const [request] = await session.listQuestions();
  expect(request?.id).not.toBe(previous?.id);
  let settled = false;
  const answering = session
    .answerQuestions(
      request!.id,
      [
        {
          questionId: request!.questions[0]!.id,
          optionIds: [request!.questions[0]!.options[0]!.id],
        },
      ],
      { timeoutMs: 5_000 },
    )
    .then(
      () => {
        settled = true;
        return "accepted";
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
  try {
    await expect.poll(() => pty.writes).toContain("\r");
    await hook("PostToolUse", {
      tool_name: "Bash",
      tool_input: { command: "true" },
      tool_response: "done",
    });
    expect(await session.listQuestions()).toEqual([request]);
    await hook("PostToolUse", {
      tool_use_id: "old",
      tool_input: { questions: [replacement] },
      tool_response: {},
    });
    expect(await session.listQuestions()).toEqual([request]);
    await hook("PostToolUse", { tool_response: {} });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(await session.listQuestions()).toEqual([request]);
    expect(settled).toBe(false);
    await hook("PostToolUse", {
      tool_input: { questions: [replacement] },
      tool_response: { answers: { [replacement.question]: "Brief (short)" } },
    });
    expect(await answering).toBe("accepted");
    expect(await session.listQuestions()).toEqual([]);
  } finally {
    await session.kill();
    await answering;
  }
});
