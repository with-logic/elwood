/** Drive verified Claude question stages and native review (PRD §5.10, C-QUESTION-03). */
import { bracketedPasteEnd, bracketedPasteStart } from "../../core/input/constants.ts";
import type { QuestionFrame, QuestionIo } from "../../core/questions/adapter.ts";
import { questionAnswerFailed } from "../../core/questions/errors.ts";
import type { ElwoodQuestion, ElwoodQuestionRequest } from "../../core/questions/types.ts";
import type { ValidatedQuestionAnswer } from "../../core/questions/validate.ts";
import { type BoundClaudeQuestionAnswer, bindClaudeQuestionAnswers } from "./bind-answers.ts";
import { questionLayoutFailed, questionNavigation } from "./navigation.ts";
import { claudeDrawnTextMatcher } from "./rows.ts";
import { parseClaudeQuestionScreen } from "./screen.ts";

/** The empty Other editor; a notice Claude replaced on its row leaves blank cells after it. */
const EMPTY_OTHER_EDITOR = "Type something.";
const usesCheckboxes = {
  single: false,
  multiple: true,
  none: false,
} satisfies Readonly<Record<ElwoodQuestion["selection"], boolean>>;

/** Requires native question 0 and a complete normalized batch in request order. */
export async function answerClaudeQuestions(
  request: ElwoodQuestionRequest,
  answers: readonly ValidatedQuestionAnswer[],
  io: QuestionIo,
): Promise<void> {
  const bound = bindClaudeQuestionAnswers(request, answers);
  const initial = io.frame();
  const first = initial && parseClaudeQuestionScreen(initial, request.questions);
  if (first?.kind !== "question" || first.questionIndex !== 0) throw questionLayoutFailed();
  const { hasSubmitTab } = first;
  for (const entry of bound) {
    const index = entry.questionIndex;
    await answerOne(request, entry, io, hasSubmitTab);
    if (index + 1 < request.questions.length) {
      await io.wait((frame) => {
        const screen = parseClaudeQuestionScreen(frame, request.questions);
        return screen?.kind === "question" && screen.questionIndex === index + 1;
      });
    }
  }
  if (hasSubmitTab) await submitReview(request, bound, io);
}
async function answerOne(
  request: ElwoodQuestionRequest,
  bound: BoundClaudeQuestionAnswer,
  io: QuestionIo,
  hasSubmitTab: boolean,
): Promise<void> {
  const { question, questionIndex, answer, otherCursorIndex, targetCursorIndex } = bound;
  const navigation = questionNavigation(request, questionIndex, io, hasSubmitTab);
  // Validation requires text for a `none` question, so only `single` can lack it.
  const answerTextIsAbsentOrDrawn =
    answer.text === undefined ? () => true : claudeDrawnTextMatcher(answer.text);
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
    const { text } = answer;
    await navigation.move(otherCursorIndex);
    await io.write(
      `${bracketedPasteStart}${text}${bracketedPasteEnd}`,
      (frame) => navigation.at(frame)?.other.replace(/ +$/, "") === EMPTY_OTHER_EDITOR,
    );
    await io.wait((frame) => {
      const pasted = navigation.at(frame);
      return pasted !== undefined && answerTextIsAbsentOrDrawn(pasted.other);
    });
  }
  await navigation.move(targetCursorIndex);
  await io.write("\r", (frame) => {
    const current = navigation.at(frame);
    if (current?.cursor !== targetCursorIndex) return false;
    const matchesBySelection = {
      single: () => answerTextIsAbsentOrDrawn(current.other),
      multiple: () =>
        current.checked.every((checked, index) => checked === answer.optionIndexes.includes(index)),
      none: () => answerTextIsAbsentOrDrawn(current.other),
    } satisfies Readonly<Record<ElwoodQuestion["selection"], () => boolean>>;
    return matchesBySelection[question.selection]();
  });
}
async function submitReview(
  request: ElwoodQuestionRequest,
  answers: readonly BoundClaudeQuestionAnswer[],
  io: QuestionIo,
): Promise<void> {
  const reviewFrame = await io.wait(
    (frame) => parseClaudeQuestionScreen(frame, request.questions)?.kind === "review",
  );
  const showsAnswers = claudeDrawnTextMatcher(
    answers.map(({ question, nativeValue }) => `● ${question.prompt} → ${nativeValue}`).join("\n"),
  );
  const matchingReview = (frame: QuestionFrame) => {
    const screen = parseClaudeQuestionScreen(frame, request.questions);
    return screen?.kind === "review" && showsAnswers(screen.summary) ? screen : undefined;
  };
  if (!matchingReview(reviewFrame)) throw questionAnswerFailed();
  await io.write("\r", (frame) => matchingReview(frame)?.cursor === 0);
}
