/** Native submission guards and authoritative hook closure (PRD §4). */
import { expect, test } from "vitest";
import type { AskUserQuestionInput } from "../../../src/claude/hooks/tool-types.ts";
import { ClaudeQuestionAdapter } from "../../../src/claude/questions/index.ts";
import type { QuestionIo } from "../../../src/core/questions/adapter.ts";
import { questionAnswerFailed } from "../../../src/core/questions/errors.ts";
import type { ElwoodQuestionEvent } from "../../../src/core/questions/types.ts";
import { fixture, frame, registry } from "./helpers.ts";
import { composer, nativeHook, nativeQuestions } from "./lifecycle-helpers.ts";

const toolInput = {
  questions: [
    {
      question: "Which test note?",
      header: "Note",
      multiSelect: false,
      options: [
        { label: "Brief (short)", description: "A short test note." },
        { label: "Detailed (long)", description: "A long test note." },
      ],
    },
  ] satisfies AskUserQuestionInput["questions"],
} satisfies AskUserQuestionInput;
const hook = (name = "PreToolUse") => nativeHook(name, { tool_input: toolInput });

test("a rejected final write cannot latch submission ownership", async () => {
  const requests = registry();
  const adapter = new ClaudeQuestionAdapter(requests);
  adapter.observe(hook());
  const current = fixture("freeform-questions");
  adapter.render(current);
  const request = requests.list()[0]!;
  const writeContents: string[] = [];
  await expect(
    adapter.answer(request, [{ optionIndexes: [0] }], {
      signal: new AbortController().signal,
      frame: () => current,
      wait: async () => current,
      write: (input, matches) => {
        expect(matches(current)).toBe(true);
        writeContents.push(input);
        return Promise.reject(questionAnswerFailed());
      },
    }),
  ).rejects.toMatchObject({ code: "question_answer_failed" });
  expect(writeContents).toEqual(["\r"]);
  expect(requests.list()).toEqual([request]);
  adapter.render(composer());
  expect(requests.list()).toEqual([]);
  expect(adapter.blocksInput()).toBe(false);
});

test.each([
  ["PostToolUse", false, "answered"],
  ["PostToolUseFailure", true, "cancelled"],
  ["PermissionDenied", true, "cancelled"],
  ["PostToolUseFailure", false, "unavailable"],
  ["PermissionDenied", false, "unavailable"],
] as const)("%s interrupt=%s closes with %s", (name, interrupted, reason) => {
  const requests = registry();
  const adapter = new ClaudeQuestionAdapter(requests);
  const closed: ElwoodQuestionEvent[] = [];
  requests.onEvent((event) => {
    if (event.phase === "closed") closed.push(event);
  });
  adapter.observe(nativeHook());
  adapter.render(fixture("questions"));
  const request = requests.list()[0]!;
  adapter.observe(nativeHook(name, { is_interrupt: interrupted }));
  expect(closed).toEqual([expect.objectContaining({ phase: "closed", request, reason })]);
  expect(requests.list()).toEqual([]);
});

test("a predecessor review cannot publish an unseen successor", () => {
  const requests = registry();
  const adapter = new ClaudeQuestionAdapter(requests);
  adapter.observe(nativeHook());
  adapter.render(fixture("questions"));
  adapter.observe(
    nativeHook("PreToolUse", {
      tool_use_id: "next",
      tool_input: {
        questions: nativeQuestions.map((question) => ({
          ...question,
          question: `Next ${question.question}`,
        })),
      },
    }),
  );
  adapter.render(fixture("review"));
  expect(requests.list()).toEqual([]);
  expect(adapter.blocksInput()).toBe(true);
  adapter.render(
    frame(fixture("questions").text.replaceAll("Which test color?", "Next Which test color?")),
  );
  expect(requests.list()).toHaveLength(1);
  expect(requests.list()[0]?.questions[0]?.prompt).toBe("Next Which test color?");
});

test.each([
  "completed",
  "replaced",
] as const)("stale native authority after %s rejects before writing", async (state) => {
  const requests = registry();
  const adapter = new ClaudeQuestionAdapter(requests);
  adapter.observe(nativeHook());
  adapter.render(fixture("questions"));
  const request = requests.list()[0]!;
  adapter.observe(
    state === "completed"
      ? nativeHook("PostToolUse")
      : nativeHook("PreToolUse", { tool_use_id: "next" }),
  );
  const writeContents: string[] = [];
  const io: QuestionIo = {
    signal: new AbortController().signal,
    frame: () => fixture("questions"),
    wait: async () => fixture("questions"),
    write: (input) => {
      writeContents.push(input);
      return Promise.resolve();
    },
  };
  await expect(adapter.answer(request, [], io)).rejects.toMatchObject({
    code: "question_answer_failed",
  });
  expect(writeContents).toEqual([]);
});
