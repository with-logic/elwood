/** Public hook IPC cannot acknowledge a different native question request (C-QUESTION-02/03). */
import { afterEach, expect, test } from "vitest";
import type { AskUserQuestionInput } from "../../src/index.ts";
import { viewTerminalHistory } from "../helpers/live-buffer-fixture.ts";
import { fixture, frame } from "../unit/questions/helpers.ts";
import { disposeQuestionSessions, questionSession } from "./question-session-helpers.ts";

afterEach(disposeQuestionSessions);
const question = {
  question: "Which test note?",
  header: "Note",
  multiSelect: false,
  options: [
    { label: "Brief (short)", description: "A short test note." },
    { label: "Detailed (long)", description: "A long test note." },
  ],
} satisfies AskUserQuestionInput["questions"][number];
test("C-QUESTION-03 unrelated and prior ID-less completions cannot settle public answers", async () => {
  const { session, pty, hook, show: showFrame } = await questionSession({ questions: [question] });
  await viewTerminalHistory(session.terminal, pty);
  const show = (prompt: string) =>
    showFrame(frame(fixture("freeform-questions").text.replaceAll(question.question, prompt)));
  // Changed definitions replace one native identity; distinct IDs remain independent.
  await hook("PreToolUse", { tool_use_id: "current" });
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
    await expect.poll(() => pty.writes, { timeout: 5000 }).toContain("\r");
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
    expect(await session.listQuestions()).toEqual([request]);
    expect(settled).toBe(false);
    // Claude reports the recorded answers in both tool_input and tool_response.
    const answers = { [replacement.question]: "Brief (short)" };
    await hook("PostToolUse", {
      tool_input: { questions: [replacement], answers },
      tool_response: { answers },
    });
    expect(await answering).toBe("accepted");
    expect(session.terminal.snapshot().text).toContain("Historical output");
    expect(await session.listQuestions()).toEqual([]);
  } finally {
    await session.kill();
    await answering;
  }
});
