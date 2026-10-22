/** Claude Other text cannot silently replace a separately selected option (PRD §4). */
import { expect, test } from "vitest";
import { answerClaudeQuestions } from "../../../src/claude/questions/answer.ts";
import { validateQuestionAnswers } from "../../../src/core/questions/validate.ts";
import { definitions, fixture, frame, registry } from "./helpers.ts";
import { scriptedQuestionIo as ioFor } from "./scripted-io-helpers.ts";

test.each([
  { selection: "single" as const, optionIndexes: [] },
  { selection: "single" as const, optionIndexes: [1] },
  { selection: "none" as const, optionIndexes: [] },
])("Other text preserves or rejects selected options (%j)", async ({
  selection,
  optionIndexes,
}) => {
  const request = registry().publish("native", "blocking", [
    { ...definitions[0]!, selection, textMode: "additional" },
    definitions[1]!,
  ])!;
  const color = request.questions[0]!;
  const features = request.questions[1]!;
  const answers = validateQuestionAnswers(request, [
    {
      questionId: color.id,
      optionIds: optionIndexes.map((index) => color.options[index]!.id),
      text: "custom",
    },
    { questionId: features.id, optionIds: features.options.map((option) => option.id) },
  ]);
  expect(answers[0]!.optionIndexes).toEqual(optionIndexes);
  const colorOther = frame(
    fixture("questions")
      .text.replace("❯ 1.", "  1.")
      .replace("  3. Type something.", "❯ 3. Type something."),
  );
  const colorTyped = frame(colorOther.text.replace("Type something.", "custom"));
  const logging = fixture("features-logging");
  const metricsCursor = frame(logging.text.replace("❯ 1.", "  1.").replace("  2. [ ]", "❯ 2. [ ]"));
  const otherCursor = frame(
    fixture("features-both").text.replace("❯ 2.", "  2.").replace("  3. [ ]", "❯ 3. [ ]"),
  );
  const review = frame(fixture("review").text.replace("→ Blue", "→ custom"));
  const { io, writes } = ioFor(fixture("questions"), [
    fixture("color-blue-highlight"),
    colorOther,
    colorTyped,
    fixture("features-initial"),
    logging,
    metricsCursor,
    fixture("features-both"),
    otherCursor,
    fixture("features-submit-highlight"),
    review,
    fixture("answered"),
  ]);
  const pending = answerClaudeQuestions(request, answers, io);
  if (optionIndexes.length > 0) {
    await expect(pending).rejects.toMatchObject({ code: "question_answer_failed" });
    expect(writes).toEqual([]);
    return;
  }
  await pending;
  expect(writes).toEqual([
    "\x1b[B",
    "\x1b[B",
    "\x1b[200~custom\x1b[201~",
    "\r",
    " ",
    "\x1b[B",
    " ",
    "\x1b[B",
    "\x1b[B",
    "\r",
    "\r",
  ]);
});
