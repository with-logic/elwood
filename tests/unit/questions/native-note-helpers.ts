/** The Claude 2.1.332 `Which test note?` captures and their Other answer flow (PRD §5.10). */
import { answerClaudeQuestions } from "../../../src/claude/questions/answer.ts";
import type { QuestionDefinition } from "../../../src/core/questions/types.ts";
import { validateQuestionAnswers } from "../../../src/core/questions/validate.ts";
import { definitions, nativeSnapshot332 as native, registry } from "./helpers.ts";
import { scriptedQuestionIo } from "./scripted-io-helpers.ts";

export const note: QuestionDefinition = {
  prompt: "Which test note?",
  header: "Note",
  options: [
    { label: "Brief", description: "Short" },
    { label: "Detailed", description: "Long" },
  ],
  selection: "single",
  textMode: "alternative",
  supportsSecretInput: false,
};
/** Asked before `note` in the grouped 2.1.332 captures. */
export const color: QuestionDefinition = definitions[0]!;

/** Answers `text` from the notice capture: Down to the empty editor, paste, then `afterPaste`. */
export async function answerNoteWith(text: string, afterPaste: string): Promise<readonly string[]> {
  const request = registry().publish("native", "blocking", [note])!;
  const answers = validateQuestionAnswers(request, [
    { questionId: request.questions[0]!.id, text },
  ]);
  const { io, writes } = scriptedQuestionIo(native("single-other-notice-native"), [
    native("single-other-placeholder-native"),
    native(afterPaste),
  ]);
  await answerClaudeQuestions(request, answers, io);
  return writes;
}
