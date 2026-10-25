/** Reconcile committed Codex native question lifecycle records (PRD §4). */
import type { ElwoodActivityEvent } from "../../core/activity/index.ts";
import { isRecord } from "../../core/predicates.ts";
import { questionAnswerFailed } from "../../core/questions/errors.ts";
import type { QuestionCloseReason } from "../../core/questions/types.ts";
import type { ValidatedQuestionAnswer } from "../../core/questions/validate.ts";
import { payloadOf } from "../transcript/payload.ts";
import { isTurnEndPayload } from "../transcript/turn-end.ts";
import { type Candidate, CandidateStore } from "./candidate-store.ts";
import { jsonRecord, questionCall, questionEnvelope, questionReplies } from "./records.ts";

export type { Candidate } from "./candidate-store.ts";

export class CodexQuestionCandidates extends CandidateStore {
  /** Bind before driver input; the transaction signal releases values after native closure. */
  expectAnswer(
    candidate: Candidate,
    answers: readonly ValidatedQuestionAnswer[],
    signal: AbortSignal,
  ): () => void {
    if (this.candidates.get(candidate.nativeKey) !== candidate) throw questionAnswerFailed();
    return this.expectations.expect(candidate, answers, signal);
  }
  observe(event: ElwoodActivityEvent): boolean {
    return this.batchNotifications(() => this.observeNative(event));
  }
  private observeNative(event: ElwoodActivityEvent): boolean {
    if (event.agent !== "codex" || event.source !== "transcript") return false;
    const payload = payloadOf(event.raw);
    if (!payload) return false;
    if (isTurnEndPayload(payload)) return this.endTurn();
    const native = questionEnvelope(payload);
    if (native) {
      if (this.disabled) return this.reserveOpaqueReservation();
      try {
        const call = questionCall(payload);
        return call ? this.reconcileCallCandidates(call) : this.unsupported(native);
      } catch {
        return this.disable();
      }
    }
    if (this.disabled) return false;
    let changed = this.replies(payload);
    if (payload["type"] === "function_call_output" && typeof payload["call_id"] === "string")
      changed = this.output(payload) || changed;
    return changed;
  }
  private replies(payload: Record<string, unknown>): boolean {
    let changed = false;
    const replies = questionReplies(payload);
    for (const { questionItemId: nativeKey } of replies) {
      const candidate = this.candidates.get(nativeKey);
      if (candidate && !candidate.queued) continue;
      const closeReason: QuestionCloseReason =
        !candidate || this.expectations.isQueuedReplyAccepted(candidate, replies)
          ? "answered"
          : "unavailable";
      changed = this.close(nativeKey, closeReason) || changed;
    }
    return changed;
  }
  private unsupported(payload: Record<string, unknown>): boolean {
    let changed = this.reserveOpaqueReservation();
    const callId = payload["type"] === "function_call" ? payload["call_id"] : payload["id"];
    this.authority.supersede(callId);
    for (const candidate of this.candidates.values()) {
      if (candidate.callId === callId) {
        this.close(candidate.nativeKey, "unavailable");
        changed = true;
      }
    }
    return changed;
  }
  private endTurn(): boolean {
    this.mutationEpoch += 1;
    const changed = this.hasReservation();
    for (const nativeKey of [...this.candidates.keys()]) this.close(nativeKey, "unavailable");
    return this.clearOpaqueReservation() || changed;
  }
  private output(payload: Record<string, unknown>): boolean {
    const candidates = [...this.candidates.values()].filter(
      (candidate) => candidate.callId === payload["call_id"],
    );
    if (candidates.length === 0) return false;
    const output = payload["output"];
    const result = jsonRecord(output);
    let changed = false;
    for (const candidate of candidates) {
      if (candidate.queued && result?.["accepted"] === true) {
        changed = this.accept(candidate) || changed;
        continue;
      }
      const answers = result?.["answers"];
      const hasAnswersForEveryQuestion =
        !candidate.queued &&
        (this.expectations.matchesOwnedBlockingAnswers(candidate, answers) ??
          (isRecord(answers) &&
            candidate.questions.every((question) => {
              const answer = answers[question.nativeId];
              return (
                isRecord(answer) &&
                Array.isArray(answer["answers"]) &&
                answer["answers"].some((value) => typeof value === "string" && value.trim())
              );
            })));
      const cancelled =
        typeof output === "string" && output.includes("was cancelled before receiving a response");
      let closeReason: QuestionCloseReason;
      if (hasAnswersForEveryQuestion) closeReason = "answered";
      else if (cancelled) closeReason = "cancelled";
      else closeReason = "unavailable";
      changed = this.close(candidate.nativeKey, closeReason) || changed;
    }
    return changed;
  }
}
