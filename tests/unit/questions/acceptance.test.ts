/** A Claude completion acknowledges an Elwood answer only with its submitted values (PRD §5.10). */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { claudeDialogInputGraceMs } from "../../../src/claude/dialog-input-grace.ts";
import {
  claudeCloseReason,
  claudeExpectedAnswers,
} from "../../../src/claude/questions/acceptance.ts";
import { bindClaudeQuestionAnswers } from "../../../src/claude/questions/bind-answers.ts";
import { ClaudeQuestionAdapter } from "../../../src/claude/questions/index.ts";
import type { QuestionFrame, QuestionIo } from "../../../src/core/questions/adapter.ts";
import type { ElwoodQuestionEvent } from "../../../src/core/questions/types.ts";
import type { ValidatedQuestionAnswer } from "../../../src/core/questions/validate.ts";
import { definitions, fixture, frame, nativeSnapshot, registry } from "./helpers.ts";
import { answeredHook, nativeHook, singleQuestionToolInput } from "./lifecycle-helpers.ts";
import { scriptedQuestionIo } from "./scripted-io-helpers.ts";

const expected = new Map([["Which test note?", "Brief (short)"]]);
const completion = (answers?: Readonly<Record<string, unknown>>) => ({
  tool_input: answers === undefined ? {} : { answers },
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
});
afterEach(() => {
  vi.useRealTimers();
});

test.each([
  [{ "Which test note?": "Brief (short)" }, "answered"],
  [{ "Which test note?": "Detailed (long)" }, "unavailable"],
  [{ "Which test note?": "Brief (short)", "Another question?": "Yes" }, "unavailable"],
  [{}, "unavailable"],
  [undefined, "unavailable"],
] as const)("C-QUESTION-03 a completion reporting %j closes as %s", (answers, reason) => {
  expect(claudeCloseReason("PostToolUse", completion(answers), expected)).toBe(reason);
});

test("C-QUESTION-03 a completion without an Elwood answer closes as answered", () => {
  expect(claudeCloseReason("PostToolUse", completion(), undefined)).toBe("answered");
});

/** A published single-question request that Elwood answers once Claude's input grace passes. */
function answeredAdapter() {
  const requests = registry();
  const events: ElwoodQuestionEvent[] = [];
  requests.onEvent((event) => events.push(event));
  const adapter = new ClaudeQuestionAdapter(requests);
  adapter.observe(nativeHook("PreToolUse", { tool_input: singleQuestionToolInput }));
  adapter.render(fixture("freeform-questions"));
  const request = requests.list()[0]!;
  const answer = async (
    answers: readonly ValidatedQuestionAnswer[],
    successors: readonly QuestionFrame[],
    initial = fixture("freeform-questions"),
    refuseWrites = false,
  ) => {
    const scripted = scriptedQuestionIo(initial, successors);
    // A refused write rejects without dispatching, as when its frame guard never matches.
    const refusing: QuestionIo = {
      ...scripted.io,
      write: () => Promise.reject(new Error("refused")),
    };
    const settled = adapter.answer(request, answers, refuseWrites ? refusing : scripted.io).then(
      () => undefined,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(claudeDialogInputGraceMs);
    return { writes: scripted.writes, error: await settled };
  };
  return { adapter, events, request, answer };
}

test("C-QUESTION-03 a completion reporting another answer closes Elwood's request as unavailable", async () => {
  const { adapter, events, request, answer } = answeredAdapter();
  expect(await answer([{ optionIndexes: [0] }], [fixture("freeform-answered")])).toEqual({
    writes: ["\r"],
    error: undefined,
  });
  const other = answeredHook({ "Which test note?": "Detailed (long)" }, singleQuestionToolInput);
  expect(adapter.observe(other)).toBe(true);
  expect(events.at(-1)).toMatchObject({ phase: "closed", reason: "unavailable", request });
});

test.each([
  ["ELWOOD_NOTE_LINE1\nELWOOD_NOTE_LINE2", "answered"],
  ["ELWOOD_NOTE_LINE1\rELWOOD_NOTE_LINE2", "unavailable"],
])("C-QUESTION-03 text pasted with LF whose completion reports %j closes as %s", async (reported, reason) => {
  const { adapter, events, request, answer } = answeredAdapter();
  const second = frame(
    fixture("freeform-questions")
      .text.replace("❯ 1.", "  1.")
      .replace("  2. Detailed", "❯ 2. Detailed"),
  );
  const { writes, error } = await answer(
    [{ optionIndexes: [], text: "ELWOOD_NOTE_LINE1\r\nELWOOD_NOTE_LINE2" }],
    [
      second,
      nativeSnapshot("freeform-other-highlight-native"),
      nativeSnapshot("freeform-other-typed-native"),
      fixture("freeform-answered"),
    ],
  );
  expect(error).toBeUndefined();
  expect(writes).toEqual([
    "\x1b[B",
    "\x1b[B",
    "\x1b[200~ELWOOD_NOTE_LINE1\nELWOOD_NOTE_LINE2\x1b[201~",
    "\r",
  ]);
  const completion = answeredHook({ "Which test note?": reported }, singleQuestionToolInput);
  expect(adapter.observe(completion)).toBe(true);
  expect(events.at(-1)).toMatchObject({ phase: "closed", reason, request });
});

test("C-QUESTION-03 an answer that wrote nothing leaves a person's native answer confirmable", async () => {
  const { adapter, events, request, answer } = answeredAdapter();
  // The screen shows another questionnaire, so the answer fails its layout check before any write.
  const { writes, error } = await answer([{ optionIndexes: [0] }], [], fixture("questions"));
  expect(error).toMatchObject({ code: "question_answer_failed" });
  expect(writes).toEqual([]);
  const person = answeredHook({ "Which test note?": "Detailed (long)" }, singleQuestionToolInput);
  expect(adapter.observe(person)).toBe(true);
  expect(events.at(-1)).toMatchObject({ phase: "closed", reason: "answered", request });
});

test("C-QUESTION-03 a refused first write leaves a person's native answer confirmable", async () => {
  const { adapter, events, request, answer } = answeredAdapter();
  const { writes, error } = await answer([{ optionIndexes: [0] }], [], undefined, true);
  expect(error).toEqual(new Error("refused"));
  expect(writes).toEqual([]);
  const person = answeredHook({ "Which test note?": "Detailed (long)" }, singleQuestionToolInput);
  expect(adapter.observe(person)).toBe(true);
  expect(events.at(-1)).toMatchObject({ phase: "closed", reason: "answered", request });
});

test("C-QUESTION-03 repeated prompts cannot be answered, since a completion keys answers by prompt", () => {
  const request = registry().publish("native", "blocking", [definitions[0]!, definitions[0]!])!;
  const bound = bindClaudeQuestionAnswers(
    request,
    request.questions.map((_, index) => ({ optionIndexes: [index] })),
  );
  expect(() => claudeExpectedAnswers(bound)).toThrow(
    expect.objectContaining({ code: "question_answer_failed" }),
  );
  expect(claudeExpectedAnswers(bound.slice(0, 1))).toEqual(
    new Map([["Which test color?", "Amber"]]),
  );
});
