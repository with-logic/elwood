/** Reconcile committed Codex native question lifecycle records (PRD §4). */
import type { ElwoodActivityEvent } from "../../core/activity/index.ts";
import { isRecord } from "../../core/predicates.ts";
import { CandidateStore } from "./candidate-store.ts";
import {
  answeredQuestionIds,
  jsonRecord,
  payloadOf,
  questionCall,
  questionEnvelope,
} from "./records.ts";

export type { Candidate } from "./candidate-store.ts";

export class CodexQuestionCandidates extends CandidateStore {
  observe(event: ElwoodActivityEvent): boolean {
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
        return call ? this.add(call) : this.unsupported(native);
      } catch {
        return this.disable();
      }
    }
    if (this.disabled) return false;
    let changed = false;
    for (const key of answeredQuestionIds(payload))
      changed = this.close(key, "answered") || changed;
    if (payload["type"] === "function_call_output" && typeof payload["call_id"] === "string")
      changed = this.output(payload) || changed;
    return changed;
  }
  private unsupported(payload: Record<string, unknown>): boolean {
    let changed = this.reserveOpaqueReservation();
    const id = payload["type"] === "function_call" ? payload["call_id"] : payload["id"];
    for (const candidate of this.candidates.values()) {
      if (candidate.callId === id) {
        this.close(candidate.key, "unavailable");
        changed = true;
      }
    }
    return changed;
  }
  private endTurn(): boolean {
    this.mutationEpoch += 1;
    const changed = this.hasReservation();
    for (const key of [...this.candidates.keys()]) this.close(key, "unavailable");
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
      const accepted =
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
      changed =
        this.close(
          candidate.key,
          accepted ? "answered" : cancelled ? "cancelled" : "unavailable",
        ) || changed;
    }
    return changed;
  }
}
