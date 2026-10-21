/** Correlate Claude hooks with native questionnaire ownership (PRD §5.10, C-QUESTION-03). */
import type { ElwoodActivityEvent } from "../../core/activity/index.ts";
import { record } from "../../core/activity/meta.ts";
import type { QuestionAdapter, QuestionFrame, QuestionIo } from "../../core/questions/adapter.ts";
import type { QuestionRegistry } from "../../core/questions/registry.ts";
import type { ElwoodQuestionRequest, QuestionDefinition } from "../../core/questions/types.ts";
import type { ValidatedQuestionAnswer } from "../../core/questions/validate.ts";
import type { AskUserQuestionInput } from "../hooks/tool-types.ts";
import { isQuestions } from "../validate/tool-values.ts";
import { answerClaudeQuestions } from "./answer.ts";
import { matchesNativeQuestions } from "./correlation.ts";
import { claudeQuestionCandidate, parseClaudeQuestionScreen } from "./screen.ts";

type Candidate = { readonly key: string; readonly questions: readonly QuestionDefinition[] };
export class ClaudeQuestionAdapter implements QuestionAdapter {
  private candidate: Candidate | undefined;
  private held = false;
  private readonly registry: QuestionRegistry;
  constructor(registry: QuestionRegistry) {
    this.registry = registry;
  }
  observe(event: ElwoodActivityEvent): void {
    if (event.source !== "hook") return;
    if (event.kind === "hook_result" && event.hookEventName === "Stop") {
      if (record(record(event.raw)["result"])["decision"] !== "block") {
        this.candidate = undefined;
        this.registry.clear("unavailable");
      }
      return;
    }
    if (event.kind !== "hook") return;
    const hook = record(event.raw);
    if (hook["tool_name"] !== "AskUserQuestion") return;
    const input = record(hook["tool_input"]);
    if (!isQuestions(input["questions"])) return;
    const questions = (input as AskUserQuestionInput).questions;
    const name = hook["hook_event_name"];
    if (this.closeNativeHook(name, hook, questions)) return;
    if (name !== "PreToolUse" && name !== "PermissionRequest") return;
    if (name === "PermissionRequest" && this.candidate) return;
    const key =
      typeof hook["tool_use_id"] === "string" ? hook["tool_use_id"] : JSON.stringify(questions);
    const replacing = this.candidate && this.candidate.key !== key;
    this.candidate = {
      key,
      questions: questions.map((question) => ({
        prompt: question.question,
        header: question.header,
        options: question.options,
        selection: question.multiSelect ? "multiple" : "single",
        textMode: question.multiSelect ? "none" : "alternative",
        secret: false,
      })),
    };
    if (replacing) this.registry.clear("unavailable");
  }
  private closeNativeHook(
    name: unknown,
    hook: Readonly<Record<string, unknown>>,
    questions: AskUserQuestionInput["questions"],
  ): boolean {
    if (name !== "PostToolUse" && name !== "PostToolUseFailure" && name !== "PermissionDenied")
      return false;
    const nativeId = hook["tool_use_id"];
    if (typeof nativeId === "string") {
      if (nativeId !== this.candidate?.key) return true;
    } else if (!(this.candidate && matchesNativeQuestions(questions, this.candidate.questions)))
      return true;
    const request = this.candidate && this.registry.find(this.candidate.key);
    this.candidate = undefined;
    if (request) this.registry.close(request.id, closeReason(name, hook));
    return true;
  }
  render(frame: QuestionFrame): void {
    this.held = claudeQuestionCandidate(frame.text);
    if (!this.candidate) return;
    const current = this.registry.find(this.candidate.key);
    if (current && /(?:^|\n)⏺[ \u00a0]User declined to answer questions(?:\n|$)/.test(frame.text)) {
      this.candidate = undefined;
      this.registry.close(current.id, "cancelled");
      return;
    }
    if (!this.held || current || this.candidate.questions.length === 0) return;
    const preview: ElwoodQuestionRequest = {
      id: "preview",
      agent: "claude",
      delivery: "blocking",
      questions: this.candidate.questions.map((question) => ({
        ...question,
        id: "preview",
        options: question.options.map((option) => ({ ...option, id: "preview" })),
      })),
    };
    if (parseClaudeQuestionScreen(frame, preview))
      this.registry.publish(this.candidate.key, "blocking", this.candidate.questions);
  }
  blocksInput(): boolean {
    return this.held;
  }
  answer(
    request: ElwoodQuestionRequest,
    answers: readonly ValidatedQuestionAnswer[],
    io: QuestionIo,
  ): Promise<void> {
    return answerClaudeQuestions(request, answers, io);
  }
}

function closeReason(name: unknown, hook: Readonly<Record<string, unknown>>) {
  if (name === "PostToolUse") return "answered";
  return hook["is_interrupt"] === true ? "cancelled" : "unavailable";
}
