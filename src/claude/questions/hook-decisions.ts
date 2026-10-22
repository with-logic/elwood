/** Defer question metadata until its correlated caller hook decision resolves (PRD §6). */
import type { ElwoodActivityEvent } from "../../core/activity/index.ts";
import { record } from "../../core/activity/meta.ts";
import type { QuestionAdapter, QuestionFrame, QuestionIo } from "../../core/questions/adapter.ts";
import type { ElwoodQuestionRequest } from "../../core/questions/types.ts";
import type { ValidatedQuestionAnswer } from "../../core/questions/validate.ts";
import { isBlock } from "../hooks/dispatch.ts";
import type { ClaudeHookResult } from "../hooks/index.ts";
import type { ClaudeQuestionAdapter } from "./index.ts";

export class ClaudeQuestionHookGate implements QuestionAdapter {
  private pending: ElwoodActivityEvent | undefined;
  private readonly adapter: ClaudeQuestionAdapter;
  constructor(adapter: ClaudeQuestionAdapter) {
    this.adapter = adapter;
  }

  observe(event: ElwoodActivityEvent): boolean {
    const hook = record(event.raw);
    const isQuestionRequestHook =
      event.source === "hook" &&
      event.kind === "hook" &&
      hook["tool_name"] === "AskUserQuestion" &&
      (hook["hook_event_name"] === "PreToolUse" || hook["hook_event_name"] === "PermissionRequest");
    if (isQuestionRequestHook) {
      this.pending = event;
      return false;
    }
    const isUnblockedStopResult =
      event.source === "hook" &&
      event.kind === "hook_result" &&
      event.hookEventName === "Stop" &&
      !isBlock(hook["result"]);
    if (isUnblockedStopResult) this.pending = undefined;
    return this.adapter.observe(event);
  }

  /** Use the exact frozen original hook passed to onHookOutcome, never a clone or activity wrapper. */
  resolveHookResult(originalHookEvent: unknown, hookResult: ClaudeHookResult): void {
    const pending = this.pending;
    if (!pending || pending.raw !== originalHookEvent) return;
    this.pending = undefined;
    const decision = record(hookResult);
    const answered = Object.keys(record(record(decision["updatedInput"])["answers"])).length > 0;
    const denied = decision["permissionDecision"] === "deny" || decision["behavior"] === "deny";
    if (answered || denied) this.adapter.withdraw(pending);
    else this.adapter.observe(pending);
    // The CLI cannot paint the resulting panel until the hook response returns.
    // Only the next completed native frame may publish the resolved candidate.
  }

  render(frame: QuestionFrame): void {
    if (!this.pending) this.adapter.render(frame);
  }
  blocksInput(): boolean {
    return this.pending !== undefined || this.adapter.blocksInput();
  }
  answer(
    request: ElwoodQuestionRequest,
    answers: readonly ValidatedQuestionAnswer[],
    io: QuestionIo,
  ) {
    return this.adapter.answer(request, answers, io);
  }
}
