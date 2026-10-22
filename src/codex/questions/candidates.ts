/** Reconcile committed Codex native question lifecycle records (PRD §4). */
import type { ElwoodActivityEvent } from "../../core/activity/index.ts";
import { isRecord } from "../../core/predicates.ts";
import type { QuestionCloseReason } from "../../core/questions/types.ts";
import { CandidateStore } from "./candidate-store.ts";
import {
  answeredQuestionItemIds,
  jsonRecord,
  payloadOf,
  questionCall,
  questionEnvelope,
} from "./records.ts";

export type { Candidate } from "./candidate-store.ts";

export class CodexQuestionCandidates extends CandidateStore {
  observe(event: ElwoodActivityEvent): boolean {
    return this.batchNotifications(() => this.observeNative(event));
  }
  private observeNative(event: ElwoodActivityEvent): boolean {
    if (event.agent !== "codex" || event.source !== "transcript") return false;
    const payload = payloadOf(event.raw);
    if (!payload) return false;
    const type = payload["type"];
    if (
      typeof type === "string" &&
      ["task_complete", "turn_complete", "turn_aborted", "turn_failed"].includes(type)
    ) {
      return this.endTurn();
    }
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
    let changed = false;
    for (const nativeKey of answeredQuestionItemIds(payload))
      changed = this.close(nativeKey, "answered") || changed;
    if (payload["type"] === "function_call_output" && typeof payload["call_id"] === "string")
      changed = this.output(payload) || changed;
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
        isRecord(answers) &&
        candidate.questions.every((question) => {
          const answer = answers[question.nativeId];
          return (
            isRecord(answer) &&
            Array.isArray(answer["answers"]) &&
            answer["answers"].some((value) => typeof value === "string" && value.trim())
          );
        });
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
