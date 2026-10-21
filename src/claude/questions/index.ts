/** Correlate Claude hooks with native questionnaire ownership (PRD §4). */
import type { ElwoodActivityEvent } from "../../core/activity/index.ts";
import { record } from "../../core/activity/meta.ts";
import type { QuestionAdapter, QuestionFrame, QuestionIo } from "../../core/questions/adapter.ts";
import { questionAnswerFailed } from "../../core/questions/errors.ts";
import type { QuestionRegistry } from "../../core/questions/registry.ts";
import type { ElwoodQuestionRequest, QuestionDefinition } from "../../core/questions/types.ts";
import type { ValidatedQuestionAnswer } from "../../core/questions/validate.ts";
import { claudeEmptyInputRows } from "../composer/empty-input.ts";
import { isBlock } from "../hooks/dispatch.ts";
import type { AskUserQuestionInput } from "../hooks/tool-types.ts";
import { claudeComposerInputColumn } from "../screen-table.ts";
import { isQuestions } from "../validate/tool-values.ts";
import { answerClaudeQuestions } from "./answer.ts";
import { matchesNativeQuestions } from "./correlation.ts";
import { normalizeClaudeQuestionText } from "./rows.ts";
import {
  claudeQuestionCandidate,
  parseClaudeQuestionScreen,
  readClaudeQuestionPanel,
} from "./screen.ts";

type Candidate = {
  readonly nativeKey: string;
  readonly questions: readonly QuestionDefinition[];
  awaitingNativeHookClosure: boolean;
  readonly requiresExactQuestionMatch: boolean;
};
export class ClaudeQuestionAdapter implements QuestionAdapter {
  private candidate: Candidate | undefined;
  private held = false;
  private seenChrome = false;
  private lastNativeQuestions: readonly QuestionDefinition[] | undefined;
  private readonly registry: QuestionRegistry;
  constructor(registry: QuestionRegistry) {
    this.registry = registry;
  }
  observe(event: ElwoodActivityEvent): boolean {
    if (event.source !== "hook") return false;
    if (event.kind === "hook_result" && event.hookEventName === "Stop") {
      if (isBlock(record(event.raw)["result"])) return false;
      const changed = Boolean(this.candidate || this.held || this.registry.hasPending());
      this.candidate = undefined;
      this.held = false;
      this.seenChrome = false;
      this.registry.clear("unavailable");
      return changed;
    }
    if (event.kind !== "hook") return false;
    const hook = record(event.raw);
    if (hook["tool_name"] !== "AskUserQuestion") return false;
    const input = record(hook["tool_input"]);
    if (!isQuestions(input["questions"])) return false;
    const questions = (input as AskUserQuestionInput).questions;
    const hookEventName = hook["hook_event_name"];
    if (
      hookEventName === "PostToolUse" ||
      hookEventName === "PostToolUseFailure" ||
      hookEventName === "PermissionDenied"
    )
      return this.closeNativeHook(hookEventName, hook, questions);
    if (hookEventName !== "PreToolUse" && hookEventName !== "PermissionRequest") return false;
    const toolUseId = hook["tool_use_id"];
    if (matchesCandidateHook(this.candidate, questions, toolUseId, hookEventName)) return false;
    const nativeKey = typeof toolUseId === "string" ? toolUseId : JSON.stringify(questions);
    const previous = this.candidate && this.registry.find(this.candidate.nativeKey);
    this.candidate = {
      nativeKey,
      awaitingNativeHookClosure: false,
      requiresExactQuestionMatch:
        this.lastNativeQuestions !== undefined &&
        !matchesNativeQuestions(questions, this.lastNativeQuestions),
      questions: questions.map((question) => ({
        prompt: question.question,
        header: question.header,
        options: question.options.map((option) => ({ ...option })),
        selection: question.multiSelect ? "multiple" : "single",
        textMode: question.multiSelect ? "none" : "alternative",
        secret: false,
      })),
    };
    this.seenChrome = false;
    if (previous) this.registry.close(previous.id, "unavailable");
    return true;
  }
  private closeNativeHook(
    hookEventName: unknown,
    hook: Readonly<Record<string, unknown>>,
    questions: AskUserQuestionInput["questions"],
  ): boolean {
    const candidate = this.candidate;
    if (!candidate) return false;
    const toolUseId = hook["tool_use_id"];
    if (typeof toolUseId === "string") {
      if (toolUseId !== candidate.nativeKey) return false;
    } else if (!matchesNativeQuestions(questions, candidate.questions)) return false;
    const request = this.registry.find(candidate.nativeKey);
    this.candidate = undefined;
    this.seenChrome = false;
    if (request) this.registry.close(request.id, closeReason(hookEventName, hook));
    return true;
  }
  render(frame: QuestionFrame): void {
    this.held = claudeQuestionCandidate(frame.text);
    const candidate = this.candidate;
    if (!candidate) return;
    const screen = parseClaudeQuestionScreen(frame, candidate.questions);
    if (screen?.kind === "question") this.lastNativeQuestions = candidate.questions;
    const matchesCompleteQuestion = screen?.kind === "question";
    const hasMatchingNativePanel =
      this.held &&
      (matchesCompleteQuestion ||
        (!candidate.requiresExactQuestionMatch &&
          matchesCandidateChrome(frame, candidate.questions)));
    if (hasMatchingNativePanel) this.seenChrome = true;
    const current = this.registry.find(candidate.nativeKey);
    const hasLiveEmptyComposer =
      frame.cursorVisible === true &&
      frame.cursorX === claudeComposerInputColumn &&
      claudeEmptyInputRows(frame.lines, frame.cursorRow);
    const canRetireFromComposer =
      !candidate.awaitingNativeHookClosure && this.seenChrome && hasLiveEmptyComposer;
    if (canRetireFromComposer) {
      this.candidate = undefined;
      this.seenChrome = false;
      if (current) this.registry.close(current.id, "unavailable");
      return;
    }
    if (!this.held || current || candidate.questions.length === 0) return;
    if (screen?.kind === "question")
      this.registry.publish(candidate.nativeKey, "blocking", candidate.questions);
  }
  blocksInput(): boolean {
    return Boolean(this.candidate || this.held);
  }
  async answer(
    request: ElwoodQuestionRequest,
    answers: readonly ValidatedQuestionAnswer[],
    io: QuestionIo,
  ): Promise<void> {
    const candidate = this.candidate;
    if (!candidate || this.registry.keyFor(request.id) !== candidate.nativeKey)
      throw questionAnswerFailed();
    return await answerClaudeQuestions(request, answers, io, () => {
      candidate.awaitingNativeHookClosure = true;
    });
  }
}

function closeReason(hookEventName: unknown, hook: Readonly<Record<string, unknown>>) {
  if (hookEventName === "PostToolUse") return "answered";
  return hook["is_interrupt"] === true ? "cancelled" : "unavailable";
}

/** Correlate only the live panel's tabs and prompt; option grammar may still be unsupported. */
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

/** PermissionRequest can mirror PreToolUse with a different hook ID for the same input. */
function matchesCandidateHook(
  candidate: Candidate | undefined,
  questions: AskUserQuestionInput["questions"],
  toolUseId: unknown,
  hookEventName: unknown,
): boolean {
  const matchesCandidateQuestions =
    candidate !== undefined && matchesNativeQuestions(questions, candidate.questions);
  const matchesCandidateIdentity =
    typeof toolUseId !== "string" ||
    toolUseId === candidate?.nativeKey ||
    hookEventName === "PermissionRequest";
  return matchesCandidateQuestions && matchesCandidateIdentity;
}
