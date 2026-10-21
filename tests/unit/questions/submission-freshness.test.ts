/** Revalidate native answer values at each submitting write (C-QUESTION-03). */
import { expect, test } from "vitest";
import { answerClaudeQuestions } from "../../../src/claude/questions/answer.ts";
import type { QuestionFrame, QuestionIo } from "../../../src/core/questions/adapter.ts";
import { questionAnswerFailed } from "../../../src/core/questions/errors.ts";
import { definitions, fixture, frame, nativeSnapshot, registry } from "./helpers.ts";

function changingInput(
  initial: QuestionFrame,
  steps: readonly QuestionFrame[],
  beforeWrite: number,
  change: (current: QuestionFrame) => QuestionFrame,
) {
  let current = initial;
  const writes: string[] = [];
  const io: QuestionIo = {
    signal: new AbortController().signal,
    frame: () => current,
    wait: (matches) => {
      if (!matches(current)) throw questionAnswerFailed();
      return Promise.resolve(current);
    },
    write: (input, matches) => {
      if (writes.length === beforeWrite) current = change(current);
      if (!matches(current)) throw questionAnswerFailed();
      writes.push(input);
      current = steps[writes.length - 1] ?? current;
      return Promise.resolve();
    },
  };
  return { io, writes };
}

test("C-QUESTION-03 rejects review values changed after the review wait", async () => {
  const request = registry().publish("native", "blocking", definitions)!;
  const logging = fixture("features-logging");
  const metrics = frame(logging.text.replace("❯ 1.", "  1.").replace("  2. [ ]", "❯ 2. [ ]"));
  const other = frame(
    fixture("features-both").text.replace("❯ 2.", "  2.").replace("  3. [ ]", "❯ 3. [ ]"),
  );
  const { io, writes } = changingInput(
    fixture("questions"),
    [
      fixture("color-blue-highlight"),
      fixture("features-initial"),
      logging,
      metrics,
      fixture("features-both"),
      other,
      fixture("features-submit-highlight"),
      fixture("review"),
    ],
    8,
    (current) => frame(current.text.replace("→ Blue", "→ Amber")),
  );
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
])("C-QUESTION-03 rejects a changed $label at the submitting write", async ({ change }) => {
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

test("C-QUESTION-03 rejects Other text changed at the submitting write", async () => {
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
