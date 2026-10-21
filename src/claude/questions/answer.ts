/** Drive proven private Claude question stages and native review (PRD §4). */
import type { QuestionFrame, QuestionIo } from "../../core/questions/adapter.ts";
import { questionAnswerFailed } from "../../core/questions/errors.ts";
import type { ElwoodQuestionRequest } from "../../core/questions/types.ts";
import type { ValidatedQuestionAnswer } from "../../core/questions/validate.ts";
import { type BoundClaudeQuestionAnswer, bindClaudeQuestionAnswers } from "./bind-answers.ts";
import { questionLayoutFailed, questionNavigation } from "./navigation.ts";
import { CLAUDE_REVIEW_READY_LABEL, CLAUDE_REVIEW_TITLE } from "./review-labels.ts";
import { normalizeClaudeQuestionText } from "./rows.ts";
import { parseClaudeQuestionScreen } from "./screen.ts";

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
  const { question, questionIndex, answer, target } = bound;
  const navigation = questionNavigation(request, questionIndex, io);
  if (question.selection === "multiple") {
    if (navigation.read().checked.at(-1)) throw questionAnswerFailed();
    for (let option = 0; option < question.options.length; option += 1) {
      const selected = answer.optionIndexes.includes(option);
      if (navigation.read().checked[option] === selected) continue;
      await navigation.move(option);
      await io.write(" ", (frame) => navigation.at(frame)?.cursor === option);
      await io.wait((frame) => navigation.at(frame)?.checked[option] === selected);
    }
  }
  if (answer.text !== undefined) {
    await navigation.move(question.options.length);
    await io.write(
      `\x1b[200~${answer.text}\x1b[201~`,
      (frame) => navigation.at(frame)?.other === "Type something.",
    );
    await io.wait((frame) => navigation.at(frame)?.other === answer.text);
  }
  await navigation.move(target);
  await io.write("\r", (frame) => {
    const current = navigation.at(frame);
    if (current?.cursor !== target) return false;
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
  const text = reviewText(review);
  const expected = normalizeClaudeQuestionText(
    answers.map(({ question, reviewValue }) => `● ${question.prompt} → ${reviewValue}`).join(" "),
  );
  if (text !== expected) throw questionAnswerFailed();
  await io.write("\r", (frame) => {
    const screen = parseClaudeQuestionScreen(frame, request.questions);
    return screen?.kind === "review" && screen.cursor === 0 && reviewText(frame) === expected;
  });
}

function reviewText(frame: QuestionFrame): string {
  const start = frame.lines.findLastIndex((line) => line.trim() === CLAUDE_REVIEW_TITLE);
  const end = frame.lines.findLastIndex((line) => line.trim() === CLAUDE_REVIEW_READY_LABEL);
  return normalizeClaudeQuestionText(frame.lines.slice(start + 1, end).join(" "));
}
