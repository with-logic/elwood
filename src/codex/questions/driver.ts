/** Guard private native Codex question navigation and answer writes (PRD §4). */
import { delay } from "../../core/delay.ts";
import { bracketedPasteEnd, bracketedPasteStart } from "../../core/input/constants.ts";
import { arrowDown, arrowUp, pasteSettleDelayMs } from "../../core/input/index.ts";
import type { QuestionFrame, QuestionIo } from "../../core/questions/adapter.ts";
import { questionAnswerFailed } from "../../core/questions/errors.ts";
import type { QuestionDefinition } from "../../core/questions/types.ts";
import type { ValidatedQuestionAnswer } from "../../core/questions/validate.ts";
import { draftMatches } from "./draft.ts";
import { assertSupportedQuestions, type SupportedDriverQuestion } from "./driver-support.ts";
import { matchesQuestion, type QuestionView, questionView, queuedBadge } from "./frame.ts";
import { queuedOtherLabel } from "./labels.ts";
import { ownedEditorReceipt } from "./owned-editor.ts";

function matchingView(
  frame: QuestionFrame,
  kind: QuestionView["kind"],
  index: number,
  count: number,
  question: SupportedDriverQuestion,
): QuestionView | undefined {
  const view = questionView(frame);
  return view?.kind === kind &&
    view.index === index &&
    view.count === count &&
    matchesQuestion(view, question)
    ? view
    : undefined;
}
/** Answer one indexed queued question.
 * submitting runs after final guards, immediately before the physical Enter send attempt. */
export async function answerQueued(
  questions: readonly QuestionDefinition[],
  answer: ValidatedQuestionAnswer,
  questionIndex: number,
  io: QuestionIo,
  submitting: () => void,
): Promise<void> {
  assertSupportedQuestions(questions);
  const question = questions[questionIndex]!;
  const count = questions.length;
  let frame = io.frame();
  if (!frame) throw questionAnswerFailed();
  if (queuedBadge(frame) === count) {
    await io.write("\x1b[1;2D", (current) => queuedBadge(current) === count);
    frame = await io.wait((current) => questionView(current)?.kind === "queued");
  }
  let view = questionView(frame);
  if (
    view?.kind !== "queued" ||
    view.count !== count ||
    !matchesQuestion(view, questions[view.index]!)
  )
    throw questionAnswerFailed();
  while (view.index !== questionIndex) {
    const from = view.index;
    const next = from + (from < questionIndex ? 1 : -1);
    await io.write(
      from < questionIndex ? "\x1b[1;2D" : "\x1b[1;2C",
      (current) => matchingView(current, "queued", from, count, questions[from]!) !== undefined,
    );
    frame = await io.wait(
      (current) => matchingView(current, "queued", next, count, questions[next]!) !== undefined,
    );
    view = questionView(frame)!;
  }
  const match = (current: QuestionFrame) =>
    matchingView(current, "queued", questionIndex, count, question);
  const stagedAnswerGuard = await stageAnswer(question, answer, io, match, view);
  await io.write(
    "\r",
    (current) =>
      isAnswerReadyToSubmit(current, match(current), question, answer, stagedAnswerGuard),
    submitting,
  );
}
/** Answer the complete ordered blocking batch.
 * submitting runs after final guards, immediately before only the last Enter send attempt. */
export async function answerBlocking(
  questions: readonly QuestionDefinition[],
  answers: readonly ValidatedQuestionAnswer[],
  io: QuestionIo,
  submitting: () => void,
): Promise<void> {
  assertSupportedQuestions(questions);
  for (const [index, question] of questions.entries()) {
    const match = (frame: QuestionFrame) =>
      matchingView(frame, "blocking", index, questions.length, question);
    const frame =
      index === 0 ? io.frame() : await io.wait((current) => match(current) !== undefined);
    const initial = frame && match(frame);
    if (!initial) throw questionAnswerFailed();
    const stagedAnswerGuard = await stageAnswer(question, answers[index]!, io, match, initial);
    await io.write(
      "\r",
      (current) =>
        isAnswerReadyToSubmit(
          current,
          match(current),
          question,
          answers[index]!,
          stagedAnswerGuard,
        ),
      index === questions.length - 1 ? submitting : undefined,
    );
  }
}
type StagedAnswerGuard = (frame: QuestionFrame, view: QuestionView) => boolean;
function isAnswerReadyToSubmit(
  frame: QuestionFrame,
  view: QuestionView | undefined,
  question: SupportedDriverQuestion,
  answer: ValidatedQuestionAnswer,
  stagedAnswerGuard: StagedAnswerGuard | undefined,
): boolean {
  if (!view) return false;
  const hasExpectedSelection =
    question.options.length === 0 ||
    view.selected === selectedIndex(question, answer, view.kind === "blocking");
  if (!hasExpectedSelection) return false;
  const hasQueuedChoiceEvidence =
    view.kind === "queued" && answer.text === undefined && unownedChoice(view, question);
  const hasAnswerEvidence =
    hasQueuedChoiceEvidence ||
    (stagedAnswerGuard
      ? stagedAnswerGuard(frame, view)
      : draftMatches(view, question, answer.text ?? ""));
  return hasAnswerEvidence;
}

function selectedIndex(
  question: SupportedDriverQuestion,
  answer: ValidatedQuestionAnswer,
  modal: boolean,
): number {
  return answer.optionIndexes[0] ?? question.options.length - (modal ? 1 : 0);
}
type Matcher = (frame: QuestionFrame) => QuestionView | undefined;
async function stageAnswer(
  question: SupportedDriverQuestion,
  answer: ValidatedQuestionAnswer,
  io: QuestionIo,
  match: Matcher,
  initial: QuestionView,
): Promise<StagedAnswerGuard | undefined> {
  const modal = initial.kind === "blocking";
  const selected = selectedIndex(question, answer, modal);
  let frame: QuestionFrame;
  let view = initial;
  if (!unownedChoice(view, question)) throw questionAnswerFailed();
  // Free-text-only async questions have no numbered option selector.
  if (question.options.length > 0) {
    if (view.selected === undefined) throw questionAnswerFailed();
    while (view.selected !== selected) {
      const before = view.selected!;
      const after = before + (before < selected ? 1 : -1);
      await io.write(before < selected ? arrowDown : arrowUp, (current) => {
        const currentView = match(current);
        return currentView?.selected === before && unownedChoice(currentView, question);
      });
      frame = await io.wait((current) => match(current)?.selected === after);
      view = match(frame)!;
    }
  }
  if (modal) {
    await io.write("\t", (current) => {
      const currentView = match(current);
      return currentView?.selected === selected && unownedChoice(currentView, question);
    });
    frame = await io.wait((current) => match(current)?.notes === true);
    view = match(frame)!;
  } else if (answer.text === undefined) return;
  if (!draftMatches(view, question, "")) throw questionAnswerFailed();
  if (answer.text === undefined) return;
  await io.write(`${bracketedPasteStart}${answer.text}${bracketedPasteEnd}`, (current) => {
    const currentView = match(current);
    return currentView !== undefined && draftMatches(currentView, question, "");
  });
  if (io.signal.aborted) throw questionAnswerFailed();
  const pasted = await io.wait((current) => {
    const currentView = match(current);
    return (
      currentView !== undefined && ownedEditorReceipt(current, currentView, question) !== undefined
    );
  });
  const receipt = ownedEditorReceipt(pasted, match(pasted)!, question)!;
  await delay(pasteSettleDelayMs); // Native composer paste bursts must settle before their submitting Enter.
  return (frame, current) =>
    !io.signal.aborted && ownedEditorReceipt(frame, current, question) === receipt;
}

function unownedChoice(view: QuestionView, question: SupportedDriverQuestion): boolean {
  if (view.notes) return false;
  if (view.kind === "blocking" || question.options.length === 0) return true;
  const other = view.body.find((line) =>
    new RegExp(`^(?:› )?${question.options.length + 1}\\. `).test(line),
  );
  const text = other!.replace(/^(?:› )?\d+\. /, "");
  return text === queuedOtherLabel(question);
}
