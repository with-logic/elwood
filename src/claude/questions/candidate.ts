/** Preserve independent Claude native question identities and matching evidence (PRD §5.10). */
import type { ElwoodActivityEvent } from "../../core/activity/index.ts";
import { record } from "../../core/activity/meta.ts";
import type { QuestionFrame } from "../../core/questions/adapter.ts";
import type { QuestionDefinition } from "../../core/questions/types.ts";
import type { AskUserQuestionInput } from "../hooks/tool-types.ts";
import { isQuestions } from "../validate/tool-values.ts";
import { matchesCandidateHook, matchesNativeQuestions } from "./correlation.ts";
import { normalizeClaudeQuestionText } from "./rows.ts";
import { parseClaudeQuestionScreen, readClaudeQuestionPanel } from "./screen.ts";

export type Candidate = {
  readonly nativeKey: string;
  readonly questions: readonly QuestionDefinition[];
  awaitingNativeHookClosure: boolean;
  publishable: boolean;
  seenChrome: boolean;
  readonly requiresExactQuestionMatch: boolean;
};
export function createCandidate(
  nativeKey: string,
  questions: AskUserQuestionInput["questions"],
  lastNativeQuestions: readonly QuestionDefinition[] | undefined,
): Candidate {
  return {
    nativeKey,
    awaitingNativeHookClosure: false,
    publishable: true,
    seenChrome: false,
    requiresExactQuestionMatch:
      lastNativeQuestions !== undefined && !matchesNativeQuestions(questions, lastNativeQuestions),
    questions: questions.map((question) => ({
      prompt: question.question,
      header: question.header,
      options: question.options.map((option) => ({ ...option })),
      selection: question.multiSelect ? "multiple" : "single",
      textMode: question.multiSelect ? "none" : "alternative",
      supportsSecretInput: false,
    })),
  };
}
/** Unresolved mirrors withhold the canonical candidate without suppressing independent hooks. */
export function hasPendingHook(
  candidate: Candidate,
  pending: readonly ElwoodActivityEvent[],
): boolean {
  return pending.some((event) => {
    const hook = record(event.raw);
    const questions = record(hook["tool_input"])["questions"];
    return (
      isQuestions(questions) &&
      matchesCandidateHook(candidate, questions, hook["tool_use_id"], hook["hook_event_name"])
    );
  });
}
/** Loose unsupported choice rows may establish chrome, while publication needs a complete parse. */
export function candidatePanel(frame: QuestionFrame, candidate: Candidate, held: boolean) {
  const screen = parseClaudeQuestionScreen(frame, candidate.questions);
  const matchesCompleteQuestion = screen?.kind === "question";
  const matchesNativePanel =
    held &&
    (matchesCompleteQuestion ||
      (!candidate.requiresExactQuestionMatch &&
        matchesCandidateChrome(frame, candidate.questions)));
  return { candidate, screen, matchesNativePanel };
}
function matchesCandidateChrome(
  frame: QuestionFrame,
  questions: readonly QuestionDefinition[],
): boolean {
  const panel = readClaudeQuestionPanel(frame, questions);
  return (
    panel !== undefined &&
    questions.some((question) => normalizeClaudeQuestionText(question.prompt) === panel.prompt)
  );
}
