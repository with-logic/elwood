/** Drive proven private Claude question stages and native review (PRD §4). */
import type { QuestionFrame, QuestionIo } from "../../core/questions/adapter.ts";
import type { ElwoodQuestionRequest } from "../../core/questions/types.ts";
import type { ValidatedQuestionAnswer } from "../../core/questions/validate.ts";
import { questionLayoutFailed, questionNavigation } from "./navigation.ts";
import { normalizeClaudeQuestionText } from "./rows.ts";
import { parseClaudeQuestionScreen } from "./screen.ts";

export async function answerClaudeQuestions(
  request: ElwoodQuestionRequest,
  answers: readonly ValidatedQuestionAnswer[],
  io: QuestionIo,
): Promise<void> {
  const initial = io.frame();
  const first = initial && parseClaudeQuestionScreen(initial, request.questions);
  if (first?.kind !== "question" || first.questionIndex !== 0) throw questionLayoutFailed();
  for (const [index, answer] of answers.entries()) {
    await answerOne(request, index, answer, io);
    if (index + 1 < request.questions.length) {
      await io.wait((frame) => {
        const screen = parseClaudeQuestionScreen(frame, request.questions);
        return screen?.kind === "question" && screen.questionIndex === index + 1;
      });
    }
  }
  if (request.questions.length > 1) await submitReview(request, answers, io);
}
async function answerOne(
  request: ElwoodQuestionRequest,
  index: number,
  answer: ValidatedQuestionAnswer,
  io: QuestionIo,
): Promise<void> {
  const question = request.questions[index]!;
  const navigation = questionNavigation(request, index, io);
  if (question.selection === "multiple") {
    if (navigation.read().checked.at(-1)) throw questionLayoutFailed();
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
  let target: number;
  if (question.selection === "multiple") {
    // Checkbox dialogs place Submit after the additional Other row.
    target = question.options.length + 1;
  } else if (answer.text === undefined) {
    target = answer.optionIndexes[0]!;
  } else {
    target = question.options.length; // Single-choice freeform submits from Other.
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
  answers: readonly ValidatedQuestionAnswer[],
  io: QuestionIo,
): Promise<void> {
  const review = await io.wait(
    (frame) => parseClaudeQuestionScreen(frame, request.questions)?.kind === "review",
  );
  const text = reviewText(review);
  const expected = normalizeClaudeQuestionText(
    request.questions
      .map((question, index) => {
        const answer = answers[index]!;
        const value =
          answer.text ??
          answer.optionIndexes.map((option) => question.options[option]!.label).join(", ");
        return `● ${question.prompt} → ${value}`;
      })
      .join(" "),
  );
  if (text !== expected) throw questionLayoutFailed();
  await io.write("\r", (frame) => {
    const screen = parseClaudeQuestionScreen(frame, request.questions);
    return screen?.kind === "review" && screen.cursor === 0 && reviewText(frame) === expected;
  });
}

function reviewText(frame: QuestionFrame): string {
  const start = frame.lines.findLastIndex((line) => line.trim() === "Review your answers");
  const end = frame.lines.findLastIndex((line) => line.trim() === "Ready to submit your answers?");
  return normalizeClaudeQuestionText(frame.lines.slice(start + 1, end).join(" "));
}
