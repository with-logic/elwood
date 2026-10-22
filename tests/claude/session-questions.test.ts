/** Public Claude question discovery, held writers and native acknowledgement (C-QUESTION-01/02/03). */
import { afterEach, describe, expect, test } from "vitest";
import type {
  AskUserQuestionInput,
  ClaudeHookHandlers,
  ElwoodQuestionEvent,
} from "../../src/index.ts";
import { fixture } from "../unit/questions/helpers.ts";
import { disposeQuestionSessions, questionSession } from "./question-session-helpers.ts";

afterEach(disposeQuestionSessions);
const input = {
  questions: [
    {
      question: "Which test color?",
      header: "Color",
      options: [
        { label: "Amber", description: "Warm" },
        { label: "Blue", description: "Cool" },
      ],
      multiSelect: false,
    },
    {
      question: "Which test features?",
      header: "Features",
      options: [
        { label: "Logging", description: "Logs" },
        { label: "Metrics", description: "Counts" },
      ],
      multiSelect: true,
    },
  ],
} satisfies AskUserQuestionInput;
async function setup(hooks?: ClaudeHookHandlers) {
  const h = await questionSession(input, hooks, "native");
  return { ...h, show: (name: string) => h.show(fixture(name)) };
}
describe("C-QUESTION public Claude session", () => {
  test("C-QUESTION-01 deduplicates native redraw/mirror and exposes complete immutable late snapshot", async () => {
    const h = await setup();
    const events: ElwoodQuestionEvent[] = [];
    const activities: unknown[] = [];
    h.session.on("question", (event) => events.push(event));
    h.session.on("activity", (event) => {
      if (event.kind === "question") activities.push(event.question);
    });
    await h.hook("PreToolUse");
    expect(await h.session.listQuestions()).toEqual([]);
    await h.show("questions");
    await h.hook("PermissionRequest");
    await h.show("questions");
    const [request] = await h.session.listQuestions();
    expect(request).toMatchObject({
      agent: "claude",
      delivery: "blocking",
      questions: [
        { prompt: "Which test color?", selection: "single", textMode: "alternative" },
        { prompt: "Which test features?", selection: "multiple", textMode: "none" },
      ],
    });
    expect(Object.isFrozen(request!.questions[0]!.options)).toBe(true);
    expect(events).toHaveLength(1);
    expect(activities).toEqual(events);
    expect(h.session.status).toBe("blocked");
    await h.session.kill();
    expect(await h.session.listQuestions()).toEqual([]);
    expect(events.at(-1)).toMatchObject({ phase: "closed", reason: "unavailable" });
  });
  test("C-QUESTION-02 answers around an already-held ordinary writer and preserves its no-write hold", async () => {
    const h = await setup();
    await h.hook("PreToolUse");
    await h.show("questions");
    const [request] = await h.session.listQuestions();
    const writer = h.session.sendMessage("must remain held");
    const rejection = writer.catch((error) => error);
    await expect(h.session.answerQuestions(request!.id, [])).rejects.toMatchObject({
      code: "invalid_question_answer",
    });
    expect(h.pty.writes).toEqual([]);
    const answering = h.session.answerQuestions(
      request!.id,
      [
        {
          questionId: request!.questions[0]!.id,
          optionIds: [request!.questions[0]!.options[1]!.id],
        },
        {
          questionId: request!.questions[1]!.id,
          optionIds: request!.questions[1]!.options.map((option) => option.id),
        },
      ],
      { timeoutMs: 1500 },
    );
    await expect.poll(() => h.pty.writes).toContain("\x1b[B");
    await h.session.sendKeys("human");
    await expect(answering).rejects.toMatchObject({ code: "question_answer_failed" });
    expect(h.pty.writes.join("")).not.toContain("must remain held");
    await h.session.kill();
    expect(await rejection).toMatchObject({ code: "session_not_running" });
  });
  test("C-QUESTION-03 direct hook answers have no phantom and stale completion cannot close a newer question", async () => {
    let answerDirectly = true;
    const h = await setup({
      PreToolUse: {
        AskUserQuestion: () => {
          if (!answerDirectly) return undefined;
          answerDirectly = false;
          return {
            permissionDecision: "allow",
            updatedInput: { answers: { "Which test color?": "Blue" } },
          };
        },
      },
    });
    const directEvents: ElwoodQuestionEvent[] = [];
    h.session.on("question", (event) => directEvents.push(event));
    await h.hook("PreToolUse");
    await h.show("questions");
    expect(await h.session.listQuestions()).toEqual([]);
    expect(directEvents).toEqual([]);
    await h.hook("PostToolUse", { tool_response: { answers: { "Which test color?": "Blue" } } });
    await h.show("questions");
    expect(await h.session.listQuestions()).toEqual([]);
    await h.hook("PreToolUse", { tool_use_id: "new-native" });
    await h.show("questions");
    await expect.poll(async () => (await h.session.listQuestions()).length).toBe(1);
    await h.hook("PostToolUse", { tool_use_id: "native", tool_response: { answers: {} } });
    expect(await h.session.listQuestions()).toHaveLength(1);
  });
  test("C-QUESTION-02 interrupt revokes active question automation", async () => {
    const h = await setup();
    await h.hook("PreToolUse");
    await h.show("questions");
    const [request] = await h.session.listQuestions();
    const answering = h.session.answerQuestions(
      request!.id,
      request!.questions.map((question) => ({
        questionId: question.id,
        optionIds: [question.options[0]!.id],
      })),
      { timeoutMs: 1000 },
    );
    const rejected = expect(answering).rejects.toMatchObject({ code: "question_answer_failed" });
    await expect.poll(() => h.pty.writes.includes("\r")).toBe(true);
    await expect(h.session.interrupt({ timeoutMs: 25 })).rejects.toMatchObject({
      code: "interrupt_failed",
    });
    await rejected;
    expect(h.pty.writes.at(-1)).toBe("\x1b");
  });
});
