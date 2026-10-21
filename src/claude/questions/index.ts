/** Correlate Claude hooks with native questionnaire ownership (PRD §4). */
import type { ElwoodActivityEvent } from "../../core/activity/index.ts";
import { record } from "../../core/activity/meta.ts";
import type { QuestionAdapter, QuestionFrame, QuestionIo } from "../../core/questions/adapter.ts";
import { questionAnswerFailed } from "../../core/questions/errors.ts";
import type { QuestionRegistry } from "../../core/questions/registry.ts";
import type { ElwoodQuestionRequest, QuestionDefinition } from "../../core/questions/types.ts";
import type { ValidatedQuestionAnswer } from "../../core/questions/validate.ts";
import { claudeEmptyInputRows } from "../composer/empty-input.ts";
import type { AskUserQuestionInput } from "../hooks/tool-types.ts";
import { isQuestions } from "../validate/tool-values.ts";
import { answerClaudeQuestions } from "./answer.ts";
import { matchesNativeQuestions } from "./correlation.ts";
import { claudeQuestionRow, normalizeClaudeQuestionText } from "./rows.ts";
import {
  claudeQuestionCandidate,
  matchesClaudeQuestionTabs,
  parseClaudeQuestionScreen,
} from "./screen.ts";

type Candidate = {
  readonly key: string;
  readonly questions: readonly QuestionDefinition[];
  awaitingNative: boolean;
  readonly requiresMatchingChoices: boolean;
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
      if (record(record(event.raw)["result"])["decision"] === "block") return false;
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
    const name = hook["hook_event_name"];
    if (name === "PostToolUse" || name === "PostToolUseFailure" || name === "PermissionDenied")
      return this.closeNativeHook(name, hook, questions);
    if (name !== "PreToolUse" && name !== "PermissionRequest") return false;
    const nativeId = hook["tool_use_id"];
    if (
      this.candidate &&
      matchesNativeQuestions(questions, this.candidate.questions) &&
      (typeof nativeId !== "string" ||
        nativeId === this.candidate.key ||
        name === "PermissionRequest")
    )
      return false;
    const key = typeof nativeId === "string" ? nativeId : JSON.stringify(questions);
    const previous = this.candidate && this.registry.find(this.candidate.key);
    this.candidate = {
      key,
      awaitingNative: false,
      requiresMatchingChoices:
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
    name: unknown,
    hook: Readonly<Record<string, unknown>>,
    questions: AskUserQuestionInput["questions"],
  ): boolean {
    const candidate = this.candidate;
    if (!candidate) return false;
    const nativeId = hook["tool_use_id"];
    if (typeof nativeId === "string") {
      if (nativeId !== candidate.key) return false;
    } else if (!matchesNativeQuestions(questions, candidate.questions)) return false;
    const request = this.registry.find(candidate.key);
    this.candidate = undefined;
    this.seenChrome = false;
    if (request) this.registry.close(request.id, closeReason(name, hook));
    return true;
  }
  render(frame: QuestionFrame): void {
    this.held = claudeQuestionCandidate(frame.text);
    const candidate = this.candidate;
    if (!candidate) return;
    const screen = parseClaudeQuestionScreen(frame, candidate.questions);
    if (screen?.kind === "question") this.lastNativeQuestions = candidate.questions;
    if (
      this.held &&
      (screen?.kind === "question" ||
        (!candidate.requiresMatchingChoices && matchesCandidateChrome(frame, candidate.questions)))
    )
      this.seenChrome = true;
    const current = this.registry.find(candidate.key);
    const cleared =
      !candidate.awaitingNative &&
      this.seenChrome &&
      frame.cursorVisible === true &&
      frame.cursorX === 2 &&
      claudeEmptyInputRows(frame.lines, frame.cursorRow);
    if (cleared) {
      this.candidate = undefined;
      this.seenChrome = false;
      if (current) this.registry.close(current.id, "unavailable");
      return;
    }
    if (!this.held || current || candidate.questions.length === 0) return;
    if (screen?.kind === "question")
      this.registry.publish(candidate.key, "blocking", candidate.questions);
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
    if (!candidate || this.registry.keyFor(request.id) !== candidate.key)
      throw questionAnswerFailed();
    return await answerClaudeQuestions(request, answers, io, () => {
      candidate.awaitingNative = true;
    });
  }
}

function closeReason(name: unknown, hook: Readonly<Record<string, unknown>>) {
  if (name === "PostToolUse") return "answered";
  return hook["is_interrupt"] === true ? "cancelled" : "unavailable";
}

/** Correlate only the live panel's tabs and prompt; option grammar may still be unsupported. */
function matchesCandidateChrome(
  frame: QuestionFrame,
  questions: readonly QuestionDefinition[],
): boolean {
  if (!matchesClaudeQuestionTabs(frame, questions)) return false;
  const title = frame.lines.findLastIndex((line) => /^(?:←\s+)?\s*[☐☒] /.test(line));
  const body = frame.lines.slice(title + 1);
  const firstOption = body.findIndex((line) => claudeQuestionRow.test(line));
  if (firstOption < 0) return false;
  const prompt = normalizeClaudeQuestionText(body.slice(0, firstOption).join("\n"));
  return questions.some((question) => normalizeClaudeQuestionText(question.prompt) === prompt);
}
