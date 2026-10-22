/** Drive proven private Claude question stages and native review (PRD §4). */
import { bracketedPasteEnd, bracketedPasteStart } from "../../core/input/constants.ts";
import type { QuestionFrame, QuestionIo } from "../../core/questions/adapter.ts";
import { questionAnswerFailed } from "../../core/questions/errors.ts";
import type { ElwoodQuestionRequest } from "../../core/questions/types.ts";
import type { ValidatedQuestionAnswer } from "../../core/questions/validate.ts";
import { type BoundClaudeQuestionAnswer, bindClaudeQuestionAnswers } from "./bind-answers.ts";
import { questionLayoutFailed, questionNavigation } from "./navigation.ts";
import { normalizeClaudeQuestionText } from "./rows.ts";
import { parseClaudeQuestionScreen } from "./screen.ts";

/** Requires native question 0 and a complete normalized batch in request order.
 * Finishing these writes does not prove native acceptance; the transaction owns that acknowledgement. */
export async function answerClaudeQuestions(
  request: ElwoodQuestionRequest,
  answers: readonly ValidatedQuestionAnswer[],
  io: QuestionIo,
): Promise<void> {
  const bound = bindClaudeQuestionAnswers(request, answers);
  const initial = io.frame();
  const first = initial && parseClaudeQuestionScreen(initial, request.questions);
  if (first?.kind !== "question" || first.questionIndex !== 0) throw questionLayoutFailed();
  for (const entry of bound) {
    const index = entry.questionIndex;
    await answerOne(request, entry, io);
    if (index + 1 < request.questions.length) {
      await io.wait((frame) => {
        const screen = parseClaudeQuestionScreen(frame, request.questions);
        return screen?.kind === "question" && screen.questionIndex === index + 1;
      });
    }
  }
  if (request.questions.length > 1) await submitReview(request, bound, io);
}
async function answerOne(
  request: ElwoodQuestionRequest,
  bound: BoundClaudeQuestionAnswer,
  io: QuestionIo,
): Promise<void> {
  const { question, questionIndex, answer, otherCursorIndex, targetCursorIndex } = bound;
  const navigation = questionNavigation(request, questionIndex, io);
  if (question.selection === "multiple") {
    if (navigation.read().checked[otherCursorIndex]) throw questionAnswerFailed();
    for (let option = 0; option < question.options.length; option += 1) {
      const selected = answer.optionIndexes.includes(option);
      if (navigation.read().checked[option] === selected) continue;
      await navigation.move(option);
      await io.write(" ", (frame) => navigation.at(frame)?.cursor === option);
      await io.wait((frame) => navigation.at(frame)?.checked[option] === selected);
    }
  }
  if (answer.text !== undefined) {
    await navigation.move(otherCursorIndex);
    await io.write(
      `${bracketedPasteStart}${answer.text}${bracketedPasteEnd}`,
      (frame) => navigation.at(frame)?.other === "Type something.",
    );
    await io.wait((frame) => navigation.at(frame)?.other === answer.text);
  }
  await navigation.move(targetCursorIndex);
  await io.write("\r", (frame) => {
    const current = navigation.at(frame);
    if (current?.cursor !== targetCursorIndex) return false;
    if (question.selection === "multiple") {
      return current.checked.every(
        (checked, index) => checked === answer.optionIndexes.includes(index),
      );
    }
    return answer.text === undefined || current.other === answer.text;
  });
}
async function submitReview(
  request: ElwoodQuestionRequest,
  answers: readonly BoundClaudeQuestionAnswer[],
  io: QuestionIo,
): Promise<void> {
  const review = await io.wait(
    (frame) => parseClaudeQuestionScreen(frame, request.questions)?.kind === "review",
  );
  const expected = normalizeClaudeQuestionText(
    answers.map(({ question, reviewValue }) => `● ${question.prompt} → ${reviewValue}`).join(" "),
  );
  const matchingReview = (frame: QuestionFrame) => {
    const screen = parseClaudeQuestionScreen(frame, request.questions);
    return screen?.kind === "review" && screen.summary === expected ? screen : undefined;
  };
  if (!matchingReview(review)) throw questionAnswerFailed();
  await io.write("\r", (frame) => matchingReview(frame)?.cursor === 0);
}
