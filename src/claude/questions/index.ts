/** Correlate Claude hooks with native questionnaire ownership (PRD §5.10, §6.1; C-QUESTION-01). */
import type { ElwoodActivityEvent } from "../../core/activity/index.ts";
import { record } from "../../core/activity/meta.ts";
import type { QuestionAdapter, QuestionFrame, QuestionIo } from "../../core/questions/adapter.ts";
import { questionAnswerFailed } from "../../core/questions/errors.ts";
import { QuestionNotificationErrors } from "../../core/questions/notification-errors.ts";
import type { QuestionRegistry } from "../../core/questions/registry.ts";
import type { ElwoodQuestionRequest, QuestionDefinition } from "../../core/questions/types.ts";
import type { ValidatedQuestionAnswer } from "../../core/questions/validate.ts";
import { claudeEmptyInputRows } from "../composer/empty-input.ts";
import { isBlock } from "../hooks/dispatch.ts";
import type { AskUserQuestionInput } from "../hooks/tool-types.ts";
import { claudeComposerInputColumn } from "../screen-table.ts";
import { isQuestions } from "../validate/tool-values.ts";
import { answerClaudeQuestions } from "./answer.ts";
import { type Candidate, candidatePanel, createCandidate, hasPendingHook } from "./candidate.ts";
import { matchesCandidateHook, matchesNativeQuestions } from "./correlation.ts";
import { claudeQuestionCandidate } from "./screen.ts";

export class ClaudeQuestionAdapter implements QuestionAdapter {
  private readonly notifications = new QuestionNotificationErrors();
  private readonly candidates = new Map<string, Candidate>();
  private held = false;
  private lastNativeQuestions: readonly QuestionDefinition[] | undefined;
  private readonly registry: QuestionRegistry;
  constructor(registry: QuestionRegistry) {
    this.registry = registry;
  }
  observe(event: ElwoodActivityEvent): boolean {
    return this.notifications.run(() => this.observeHook(event));
  }
  private observeHook(event: ElwoodActivityEvent): boolean {
    if (event.source !== "hook") return false;
    if (event.kind === "hook_result" && event.hookEventName === "Stop") {
      if (isBlock(record(event.raw)["result"])) return false;
      const changed = Boolean(this.candidates.size || this.held || this.registry.hasPending());
      this.candidates.clear();
      this.held = false;
      this.notifications.capture(() => this.registry.clear("unavailable"));
      return changed;
    }
    if (event.kind !== "hook") return false;
    const hook = record(event.raw);
    if (hook["tool_name"] !== "AskUserQuestion") return false;
    const input = record(hook["tool_input"]);
    const questions = input["questions"];
    if (!isQuestions(questions)) return false;
    const hookEventName = hook["hook_event_name"];
    if (
      hookEventName === "PostToolUse" ||
      hookEventName === "PostToolUseFailure" ||
      hookEventName === "PermissionDenied"
    )
      return this.closeNativeHook(hookEventName, hook, questions);
    if (hookEventName !== "PreToolUse" && hookEventName !== "PermissionRequest") return false;
    const toolUseId = hook["tool_use_id"];
    if (
      [...this.candidates.values()].some((candidate) =>
        matchesCandidateHook(candidate, questions, toolUseId, hookEventName),
      )
    )
      return false;
    const nativeKey = typeof toolUseId === "string" ? toolUseId : JSON.stringify(questions);
    return this.replaceCandidate(nativeKey, questions);
  }
  private replaceCandidate(
    nativeKey: string,
    questions: AskUserQuestionInput["questions"],
  ): boolean {
    const existing = this.candidates.get(nativeKey);
    // Metadata mirrors cannot release an uncertain native answer reservation.
    if (existing && (existing.awaitingNativeHookClosure || this.registry.isRetired(nativeKey)))
      return false;
    const previous = this.registry.find(nativeKey);
    this.candidates.set(nativeKey, createCandidate(nativeKey, questions, this.lastNativeQuestions));
    if (previous) this.notifications.capture(() => this.registry.close(previous.id, "unavailable"));
    return true;
  }
  /** A caller resolved the hook; retain native correlation but withdraw automation authority. */
  withdraw(event: ElwoodActivityEvent): void {
    this.notifications.run(() => this.withdrawHook(event));
  }
  private withdrawHook(event: ElwoodActivityEvent): void {
    const hook = record(event.raw);
    const questions = record(hook["tool_input"])["questions"];
    if (!isQuestions(questions)) return;
    for (const candidate of this.candidates.values()) {
      if (!matchesCandidateHook(candidate, questions, hook["tool_use_id"], hook["hook_event_name"]))
        continue;
      candidate.publishable = false;
      const request = this.registry.find(candidate.nativeKey);
      if (request) this.notifications.capture(() => this.registry.retireUnconfirmed(request.id));
    }
  }
  private closeNativeHook(
    hookEventName: unknown,
    hook: Readonly<Record<string, unknown>>,
    questions: AskUserQuestionInput["questions"],
  ): boolean {
    const toolUseId = hook["tool_use_id"];
    const matches = [...this.candidates.values()].filter((candidate) =>
      typeof toolUseId === "string"
        ? toolUseId === candidate.nativeKey
        : matchesNativeQuestions(questions, candidate.questions),
    );
    if (matches.length !== 1) return false;
    this.close(matches[0]!, closeReason(hookEventName, hook));
    return true;
  }
  private close(candidate: Candidate, reason: "answered" | "cancelled" | "unavailable"): void {
    const request = this.registry.find(candidate.nativeKey);
    this.candidates.delete(candidate.nativeKey);
    if (request) this.notifications.capture(() => this.registry.close(request.id, reason));
  }
  render(frame: QuestionFrame, pendingHooks: Iterable<ElwoodActivityEvent> = []): void {
    this.notifications.run(() => this.renderCandidates(frame, pendingHooks));
  }
  private renderCandidates(
    frame: QuestionFrame,
    pendingHooks: Iterable<ElwoodActivityEvent>,
  ): void {
    this.held = claudeQuestionCandidate(frame.text);
    const pending = [...pendingHooks];
    const panels = [...this.candidates.values()]
      .filter((candidate) => !hasPendingHook(candidate, pending))
      .map((candidate) => candidatePanel(frame, candidate, this.held));
    const matching = panels.filter((panel) => panel.matchesNativePanel);
    if (matching.length > 1) {
      // The UI has no native ID: ambiguity cannot grant or retain answer authority.
      for (const { candidate } of matching) {
        const request = this.registry.find(candidate.nativeKey);
        if (request) this.notifications.capture(() => this.registry.retireUnconfirmed(request.id));
      }
      return;
    }
    const hasLiveEmptyComposer =
      frame.cursorVisible === true &&
      frame.cursorX === claudeComposerInputColumn &&
      claudeEmptyInputRows(frame.lines, frame.cursorRow);
    for (const { candidate, screen, matchesNativePanel } of panels) {
      if (this.candidates.get(candidate.nativeKey) !== candidate) continue;
      if (matchesNativePanel) candidate.seenChrome = true;
      if (screen?.kind === "question") this.lastNativeQuestions = candidate.questions;
      if (!candidate.awaitingNativeHookClosure && candidate.seenChrome && hasLiveEmptyComposer) {
        this.close(candidate, "unavailable");
        continue;
      }
      if (
        this.held &&
        candidate.publishable &&
        screen?.kind === "question" &&
        !this.registry.find(candidate.nativeKey)
      )
        this.notifications.capture(() =>
          this.registry.publish(candidate.nativeKey, "blocking", candidate.questions),
        );
    }
  }
  blocksInput(): boolean {
    return Boolean(this.candidates.size || this.held);
  }
  async answer(
    request: ElwoodQuestionRequest,
    answers: readonly ValidatedQuestionAnswer[],
    io: QuestionIo,
  ): Promise<void> {
    const nativeKey = this.registry.keyFor(request.id);
    const candidate = nativeKey === undefined ? undefined : this.candidates.get(nativeKey);
    if (!candidate) throw questionAnswerFailed();
    return await answerClaudeQuestions(request, answers, io, () => {
      candidate.awaitingNativeHookClosure = true;
    });
  }
}

function closeReason(hookEventName: unknown, hook: Readonly<Record<string, unknown>>) {
  if (hookEventName === "PostToolUse") return "answered";
  return hook["is_interrupt"] === true ? "cancelled" : "unavailable";
}
