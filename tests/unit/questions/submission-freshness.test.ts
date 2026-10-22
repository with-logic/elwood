/** Revalidate native answer values at each submitting write (PRD §4). */
import { expect, test } from "vitest";
import { answerClaudeQuestions } from "../../../src/claude/questions/answer.ts";
import type { QuestionFrame, QuestionIo } from "../../../src/core/questions/adapter.ts";
import { questionAnswerFailed } from "../../../src/core/questions/errors.ts";
import { groupedAnswerFrames } from "./grouped-frame-helpers.ts";
import { definitions, fixture, frame, nativeSnapshot, registry } from "./helpers.ts";

function changingInput(
  initial: QuestionFrame,
  steps: readonly QuestionFrame[],
  beforeWrite: number,
  change: (current: QuestionFrame) => QuestionFrame,
) {
  let current = initial;
  let pending = false;
  const writes: string[] = [];
  const io: QuestionIo = {
    signal: new AbortController().signal,
    frame: () => current,
    wait: async (matches) => {
      await Promise.resolve();
      const rendered = pending ? (steps[writes.length - 1] ?? current) : current;
      if (!matches(rendered)) throw questionAnswerFailed();
      current = rendered;
      pending = false;
      return rendered;
    },
    write: (input, matches, onDispatch) => {
      if (pending) throw new Error("Native write preceded the render barrier");
      if (writes.length === beforeWrite) current = change(current);
      if (!matches(current)) throw questionAnswerFailed();
      onDispatch?.();
      writes.push(input);
      pending = true;
      return Promise.resolve();
    },
  };
  return { io, writes };
}

test("freshness IO rejects another write until the render wait completes", async () => {
  const initial = fixture("questions");
  const successor = fixture("color-blue-highlight");
  const { io, writes } = changingInput(initial, [successor], -1, (current) => current);
  await io.write("\x1b[B", () => true);
  expect(io.frame()).toBe(initial);
  expect(() => io.write("\r", () => true)).toThrow("render barrier");
  const waiting = io.wait((current) => current === successor);
  expect(io.frame()).toBe(initial);
  expect(() => io.write("\r", () => true)).toThrow("render barrier");
  await waiting;
  expect(io.frame()).toBe(successor);
  await io.write("\r", () => true);
  expect(writes).toEqual(["\x1b[B", "\r"]);
});

test.each([
  {
    label: "summary",
    change: (current: QuestionFrame) => frame(current.text.replace("→ Blue", "→ Amber")),
  },
  { label: "foreign frame", change: (_current: QuestionFrame) => frame("foreign") },
  { label: "earlier question", change: (_current: QuestionFrame) => fixture("questions") },
  {
    label: "Cancel cursor",
    change: (current: QuestionFrame) =>
      frame(
        current.text
          .replace("❯ 1. Submit answers", "  1. Submit answers")
          .replace("  2. Cancel", "❯ 2. Cancel"),
      ),
  },
])("rejects a changed review $label at the final write", async ({ change }) => {
  const request = registry().publish("native", "blocking", definitions)!;
  const successors = groupedAnswerFrames();
  const { io, writes } = changingInput(fixture("questions"), successors, successors.length, change);
  await expect(
    answerClaudeQuestions(request, [{ optionIndexes: [1] }, { optionIndexes: [0, 1] }], io),
  ).rejects.toMatchObject({ code: "question_answer_failed" });
  expect(writes).toEqual(["\x1b[B", "\r", " ", "\x1b[B", " ", "\x1b[B", "\x1b[B", "\r"]);
});

test.each([
  {
    label: "checkbox set",
    change: (current: QuestionFrame) => frame(current.text.replace("[✔] Logging", "[ ] Logging")),
  },
  {
    label: "cursor",
    change: (current: QuestionFrame) =>
      frame(current.text.replace("❯    Submit", "     Submit").replace("  2. [✔]", "❯ 2. [✔]")),
  },
  { label: "layout", change: (_current: QuestionFrame) => frame("foreign") },
])("rejects a changed $label at the submitting write", async ({ change }) => {
  const request = registry().publish("native", "blocking", [definitions[1]!])!;
  const logging = fixture("features-logging");
  const metrics = frame(logging.text.replace("❯ 1.", "  1.").replace("  2. [ ]", "❯ 2. [ ]"));
  const other = frame(
    fixture("features-both").text.replace("❯ 2.", "  2.").replace("  3. [ ]", "❯ 3. [ ]"),
  );
  const { io, writes } = changingInput(
    singleFeatureFrame(fixture("features-initial")),
    [logging, metrics, fixture("features-both"), other, fixture("features-submit-highlight")].map(
      singleFeatureFrame,
    ),
    5,
    change,
  );
  await expect(
    answerClaudeQuestions(request, [{ optionIndexes: [0, 1] }], io),
  ).rejects.toMatchObject({
    code: "question_answer_failed",
  });
  expect(writes).toEqual([" ", "\x1b[B", " ", "\x1b[B", "\x1b[B"]);
});

test("rejects Other text changed at the submitting write", async () => {
  const request = registry().publish("note", "blocking", [
    {
      ...definitions[0]!,
      prompt: "Which test note?",
      header: "Note",
      options: [
        { label: "Brief (short)", description: "A short test note." },
        { label: "Detailed (long)", description: "A long test note." },
      ],
    },
  ])!;
  const second = frame(
    fixture("freeform-questions")
      .text.replace("❯ 1.", "  1.")
      .replace("  2. Detailed", "❯ 2. Detailed"),
  );
  const { io, writes } = changingInput(
    fixture("freeform-questions"),
    [
      second,
      nativeSnapshot("freeform-other-highlight-native"),
      nativeSnapshot("freeform-other-typed-native"),
    ],
    3,
    (current) => frame(current.text.replace("ELWOOD_NOTE_LINE2", "Changed")),
  );
  await expect(
    answerClaudeQuestions(
      request,
      [{ optionIndexes: [], text: "ELWOOD_NOTE_LINE1\nELWOOD_NOTE_LINE2" }],
      io,
    ),
  ).rejects.toMatchObject({ code: "question_answer_failed" });
  expect(writes).toHaveLength(3);
  expect(writes.at(-1)).toBe("\x1b[200~ELWOOD_NOTE_LINE1\nELWOOD_NOTE_LINE2\x1b[201~");
});

function singleFeatureFrame(current: QuestionFrame): QuestionFrame {
  return frame(current.text.replace(/^←.*$/m, " ☐ Features"));
}
