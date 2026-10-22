/** Guard private native Codex question navigation and answer writes (PRD §4). */
import { delay } from "../../core/delay.ts";
import { pasteSettleDelayMs } from "../../core/input/index.ts";
import type { QuestionFrame, QuestionIo } from "../../core/questions/adapter.ts";
import { questionAnswerFailed } from "../../core/questions/errors.ts";
import type { QuestionDefinition } from "../../core/questions/types.ts";
import type { ValidatedQuestionAnswer } from "../../core/questions/validate.ts";
import { draftMatches } from "./draft.ts";
import { matchesQuestion, type QuestionView, questionView, queuedBadge } from "./frame.ts";
import { queuedOtherLabel } from "./labels.ts";

function matchingView(
  frame: QuestionFrame,
  kind: QuestionView["kind"],
  index: number,
  count: number,
  question: QuestionDefinition,
): QuestionView | undefined {
  const view = questionView(frame);
  return view?.kind === kind &&
    view.index === index &&
    view.count === count &&
    matchesQuestion(view, question)
    ? view
    : undefined;
}
export async function answerQueued(
  questions: readonly QuestionDefinition[],
  answer: ValidatedQuestionAnswer,
  index: number,
  io: QuestionIo,
  submitting: () => void,
): Promise<void> {
  const question = questions[index]!;
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
  while (view.index !== index) {
    const from = view.index;
    const next = from + (from < index ? 1 : -1);
    await io.write(
      from < index ? "\x1b[1;2D" : "\x1b[1;2C",
      (current) => matchingView(current, "queued", from, count, questions[from]!) !== undefined,
    );
    frame = await io.wait(
      (current) => matchingView(current, "queued", next, count, questions[next]!) !== undefined,
    );
    view = questionView(frame)!;
  }
  const match = (current: QuestionFrame) => matchingView(current, "queued", index, count, question);
  await stageAnswer(question, answer, io, match, view);
  await io.write("\r", (current) => ready(match(current), question, answer), submitting);
}
export async function answerBlocking(
  questions: readonly QuestionDefinition[],
  answers: readonly ValidatedQuestionAnswer[],
  io: QuestionIo,
  submitting: () => void,
): Promise<void> {
  for (const [index, question] of questions.entries()) {
    const match = (frame: QuestionFrame) =>
      matchingView(frame, "blocking", index, questions.length, question);
    const frame =
      index === 0 ? io.frame() : await io.wait((current) => match(current) !== undefined);
    const initial = frame && match(frame);
    if (!initial) throw questionAnswerFailed();
    await stageAnswer(question, answers[index]!, io, match, initial);
    await io.write(
      "\r",
      (current) => ready(match(current), question, answers[index]!),
      index === questions.length - 1 ? submitting : undefined,
    );
  }
}
function ready(
  view: QuestionView | undefined,
  question: QuestionDefinition,
  answer: ValidatedQuestionAnswer,
): boolean {
  if (
    !view ||
    (question.options.length > 0 &&
      view.selected !== selectedIndex(question, answer, view.kind === "blocking"))
  )
    return false;
  return (
    (view.kind === "queued" && answer.text === undefined && unownedChoice(view, question)) ||
    draftMatches(view, question, answer.text ?? "")
  );
}
function selectedIndex(
  question: QuestionDefinition,
  answer: ValidatedQuestionAnswer,
  modal: boolean,
): number {
  return answer.optionIndexes[0] ?? question.options.length - (modal ? 1 : 0);
}
type Matcher = (frame: QuestionFrame) => QuestionView | undefined;
async function stageAnswer(
  question: QuestionDefinition,
  answer: ValidatedQuestionAnswer,
  io: QuestionIo,
  match: Matcher,
  initial: QuestionView,
): Promise<void> {
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
      await io.write(before < selected ? "\x1b[B" : "\x1b[A", (current) => {
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
  await io.write(`\x1b[200~${answer.text}\x1b[201~`, (current) => {
    const currentView = match(current);
    return currentView !== undefined && draftMatches(currentView, question, "");
  });
  await io.wait((current) => {
    const currentView = match(current);
    return currentView !== undefined && draftMatches(currentView, question, answer.text!);
  });
  await delay(pasteSettleDelayMs); // Native composer paste bursts must settle before their submitting Enter.
}

function unownedChoice(view: QuestionView, question: QuestionDefinition): boolean {
  if (view.notes) return false;
  if (view.kind === "blocking" || question.options.length === 0) return true;
  const other = view.body.find((line) =>
    new RegExp(`^(?:› )?${question.options.length + 1}\\. `).test(line),
  );
  const text = other!.replace(/^(?:› )?\d+\. /, "");
  return text === queuedOtherLabel(question);
}
