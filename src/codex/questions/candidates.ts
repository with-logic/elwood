/** Track durable Codex request identities and acknowledgements (PRD §7A.5). */
import type { ElwoodActivityEvent } from "../../core/activity/index.ts";
import { isRecord } from "../../core/predicates.ts";
import type { QuestionRegistry } from "../../core/questions/registry.ts";
import type { QuestionCloseReason } from "../../core/questions/types.ts";
import { QuestionBudget } from "./limits.ts";
import {
  answeredQuestionIds,
  jsonRecord,
  payloadOf,
  type QuestionCall,
  questionCall,
  queuedKey,
} from "./records.ts";

export type Candidate = {
  readonly key: string;
  readonly callId: string;
  readonly queued: boolean;
  readonly questions: QuestionCall["questions"];
  accepted: boolean;
  submitting: boolean;
  published: boolean;
  readonly bytes: number;
};
export class CodexQuestionCandidates {
  readonly candidates = new Map<string, Candidate>();
  private readonly budget = new QuestionBudget();
  private disabled = false;
  private readonly registry: QuestionRegistry;
  constructor(registry: QuestionRegistry) {
    this.registry = registry;
  }
  observe(event: ElwoodActivityEvent): boolean {
    if (this.disabled || event.agent !== "codex" || event.source !== "transcript") return false;
    const payload = payloadOf(event.raw);
    if (!payload) return false;
    if (
      ["task_complete", "turn_complete", "turn_aborted", "turn_failed"].includes(
        String(payload["type"]),
      )
    ) {
      for (const key of [...this.candidates.keys()]) this.close(key, "unavailable");
      return true;
    }
    try {
      const call = questionCall(payload);
      if (call) this.add(call);
    } catch {
      this.disable();
      return false;
    }
    for (const key of answeredQuestionIds(payload)) this.close(key, "answered");
    if (payload["type"] === "function_call_output" && typeof payload["call_id"] === "string")
      this.output(payload["call_id"], payload["output"]);
    return false;
  }
  queued(): Candidate[] {
    return [...this.candidates.values()].filter(
      (candidate) => candidate.queued && candidate.accepted,
    );
  }
  private add(call: QuestionCall): void {
    const groups = call.queued
      ? call.questions.map((question, index) => ({
          key: queuedKey(call.callId, index),
          questions: [question],
        }))
      : [{ key: call.callId, questions: call.questions }];
    for (const group of groups) {
      if (this.budget.hasRetired(group.key)) continue;
      const existing = this.candidates.get(group.key);
      if (existing && JSON.stringify(existing.questions) === JSON.stringify(group.questions)) {
        existing.accepted ||= call.accepted;
        continue;
      }
      const bytes = Buffer.byteLength(JSON.stringify([group.key, call.callId, group.questions]));
      this.budget.replace(
        this.candidates.size + (existing ? 0 : 1),
        bytes - (existing?.bytes ?? 0),
      );
      const previous = this.registry.find(group.key);
      if (previous) this.closeRequest(previous.id, "unavailable");
      this.candidates.set(group.key, {
        ...group,
        callId: call.callId,
        queued: call.queued,
        accepted: call.accepted,
        submitting: false,
        published: false,
        bytes,
      });
    }
  }
  publish(candidate: Candidate): void {
    if (candidate.published || this.disabled) return;
    try {
      this.registry.publish(
        candidate.key,
        candidate.queued ? "queued" : "blocking",
        candidate.questions.map((question) => question.definition),
      );
    } catch {
      /* A public observer must not prevent publishing the remaining native units. */
    } finally {
      candidate.published = this.registry.find(candidate.key) !== undefined;
    }
  }
  close(key: string, reason: QuestionCloseReason): void {
    if (this.disabled) return;
    try {
      this.budget.retire(key);
    } catch {
      this.disable();
      return;
    }
    this.budget.replace(this.candidates.size, -(this.candidates.get(key)?.bytes ?? 0));
    this.candidates.delete(key);
    const request = this.registry.find(key);
    if (request) this.closeRequest(request.id, reason);
  }
  private disable(): void {
    this.disabled = true;
    const keys = [...this.candidates.keys()];
    this.candidates.clear();
    this.budget.clear();
    for (const key of keys) {
      const request = this.registry.find(key);
      if (request) this.closeRequest(request.id, "unavailable");
    }
  }
  private closeRequest(id: string, reason: QuestionCloseReason): void {
    try {
      this.registry.close(id, reason);
    } catch {
      /* Retire every native unit even when a public close observer throws. */
    }
  }
  private output(callId: string, output: unknown): void {
    const candidates = [...this.candidates.values()].filter(
      (candidate) => candidate.callId === callId,
    );
    const result = jsonRecord(output);
    for (const candidate of candidates) {
      if (candidate.queued && result?.["accepted"] === true) {
        candidate.accepted = true;
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
      this.close(
        candidate.key,
        accepted
          ? "answered"
          : typeof output === "string" &&
              output.includes("was cancelled before receiving a response")
            ? "cancelled"
            : "unavailable",
      );
    }
  }
}
