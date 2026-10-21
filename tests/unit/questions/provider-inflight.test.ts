/** Preserve Claude native completion through same-key in-flight metadata mirrors (PRD §4). */
import { expect, test } from "vitest";
import { ClaudeQuestionAdapter } from "../../../src/claude/questions/index.ts";
import type { ElwoodQuestionEvent } from "../../../src/core/questions/types.ts";
import { fixture, frame, registry } from "./helpers.ts";
import { nativeHook } from "./lifecycle-helpers.ts";
import { scriptedQuestionIo } from "./scripted-io.ts";

const questions = [
  {
    question: "Which test note?",
    header: "Note",
    multiSelect: false,
    options: [
      { label: "Brief (short)", description: "A short test note." },
      { label: "Detailed (long)", description: "A long test note." },
    ],
  },
];
const hook = (changed = false, name = "PreToolUse") =>
  nativeHook(name, {
    tool_input: {
      questions: questions.map((question) => ({
        ...question,
        question: changed ? `Changed ${question.question}` : question.question,
      })),
    },
  });

test("Claude final Enter retains its original request across changed metadata until late native closure", async () => {
  const requests = registry();
  const events: ElwoodQuestionEvent[] = [];
  requests.onEvent((event) => events.push(event));
  const adapter = new ClaudeQuestionAdapter(requests);
  adapter.observe(hook());
  adapter.render(fixture("freeform-questions"));
  const original = requests.list()[0]!;
  const scripted = scriptedQuestionIo(fixture("freeform-questions"), [
    fixture("freeform-answered"),
  ]);
  await adapter.answer(original, [{ optionIndexes: [0] }], scripted.io);
  expect(scripted.writes).toEqual(["\r"]);
  expect(adapter.observe(hook(true))).toBe(false);
  adapter.render(
    frame(
      fixture("freeform-questions").text.replaceAll("Which test note?", "Changed Which test note?"),
    ),
  );
  expect(requests.find("native")).toBe(original);
  expect(requests.list()).toEqual([original]);
  expect(events.map((event) => event.phase)).toEqual(["raised"]);
  expect(adapter.observe(hook(false, "PostToolUse"))).toBe(true);
  expect(events.at(-1)).toMatchObject({ phase: "closed", reason: "answered", request: original });
  expect(requests.find("native")).toBeUndefined();
  await expect(
    adapter.answer(original, [{ optionIndexes: [0] }], scripted.io),
  ).rejects.toMatchObject({ code: "question_answer_failed" });
  expect(scripted.writes).toEqual(["\r"]);
});
