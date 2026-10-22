/** Drive proven private Claude question stages and native review (PRD §4). */
import { bracketedPasteEnd, bracketedPasteStart } from "../../core/input/constants.ts";
import type { QuestionFrame, QuestionIo } from "../../core/questions/adapter.ts";
import { questionAnswerFailed } from "../../core/questions/errors.ts";
import type { ElwoodQuestion, ElwoodQuestionRequest } from "../../core/questions/types.ts";
import type { ValidatedQuestionAnswer } from "../../core/questions/validate.ts";
import { type BoundClaudeQuestionAnswer, bindClaudeQuestionAnswers } from "./bind-answers.ts";
import { questionLayoutFailed, questionNavigation } from "./navigation.ts";
import { normalizeClaudeQuestionText } from "./rows.ts";
import { parseClaudeQuestionScreen } from "./screen.ts";

const usesCheckboxes = {
  single: false,
  multiple: true,
  none: false,
} satisfies Readonly<Record<ElwoodQuestion["selection"], boolean>>;

/** Requires native question 0 and a complete normalized batch in request order.
 * `submitting` reports a final-submit attempt inside the accepted current-frame
 * guard, before io.write attempts Enter. It proves neither physical delivery nor
 * native acceptance; the transaction owns the native acknowledgement. */
export async function answerClaudeQuestions(
  request: ElwoodQuestionRequest,
  answers: readonly ValidatedQuestionAnswer[],
  io: QuestionIo,
  submitting: () => void = () => {
    // Standalone driver callers have no candidate lifecycle to notify.
  },
): Promise<void> {
  const bound = bindClaudeQuestionAnswers(request, answers);
  const initial = io.frame();
  const first = initial && parseClaudeQuestionScreen(initial, request.questions);
  if (first?.kind !== "question" || first.questionIndex !== 0) throw questionLayoutFailed();
  // Claude shows the final review only for grouped requests.
  const hasNativeReviewStage = request.questions.length > 1;
  for (const entry of bound) {
    const index = entry.questionIndex;
    await answerOne(request, entry, io, request.questions.length === 1 ? submitting : undefined);
    if (index + 1 < request.questions.length) {
      await io.wait((frame) => {
        const screen = parseClaudeQuestionScreen(frame, request.questions);
        return screen?.kind === "question" && screen.questionIndex === index + 1;
      });
    }
  }
  if (hasNativeReviewStage) await submitReview(request, bound, io, submitting);
}
async function answerOne(
  request: ElwoodQuestionRequest,
  bound: BoundClaudeQuestionAnswer,
  io: QuestionIo,
  submitting: (() => void) | undefined,
): Promise<void> {
  const { question, questionIndex, answer, otherCursorIndex, targetCursorIndex } = bound;
  const navigation = questionNavigation(request, questionIndex, io);
  if (usesCheckboxes[question.selection]) {
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
    const matchesBySelection = {
      single: () => answer.text === undefined || current.other === answer.text,
      multiple: () =>
        current.checked.every((checked, index) => checked === answer.optionIndexes.includes(index)),
      none: () => current.other === answer.text,
    } satisfies Readonly<Record<ElwoodQuestion["selection"], () => boolean>>;
    const matches = matchesBySelection[question.selection]();
    if (matches) submitting?.();
    return matches;
  });
}
async function submitReview(
  request: ElwoodQuestionRequest,
  answers: readonly BoundClaudeQuestionAnswer[],
  io: QuestionIo,
  submitting: () => void,
): Promise<void> {
  const reviewFrame = await io.wait(
    (frame) => parseClaudeQuestionScreen(frame, request.questions)?.kind === "review",
  );
  const expected = normalizeClaudeQuestionText(
    answers.map(({ question, reviewValue }) => `● ${question.prompt} → ${reviewValue}`).join(" "),
  );
  const matchingReview = (frame: QuestionFrame) => {
    const screen = parseClaudeQuestionScreen(frame, request.questions);
    return screen?.kind === "review" && screen.summary === expected ? screen : undefined;
  };
  if (!matchingReview(reviewFrame)) throw questionAnswerFailed();
  await io.write("\r", (frame) => {
    const matches = matchingReview(frame)?.cursor === 0;
    if (matches) submitting();
    return matches;
  });
}
