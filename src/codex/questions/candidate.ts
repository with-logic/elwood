/** Preserve native question identity discriminants in PRD §4 candidate groups. */
import type { ModalNativeQuestion, QueuedNativeQuestion } from "./definitions.ts";
import { type QuestionCall, queuedKey } from "./records.ts";

type CandidateGroup = { readonly key: string } & (
  | { readonly queued: false; readonly questions: readonly ModalNativeQuestion[] }
  | { readonly queued: true; readonly questions: readonly QueuedNativeQuestion[] }
);
export type Candidate = CandidateGroup & {
  readonly callId: string;
  accepted: boolean;
  submitting: boolean;
  published: boolean;
  readonly bytes: number;
};
export function candidateGroups(call: QuestionCall): readonly CandidateGroup[] {
  return call.queued
    ? call.questions.map((question, index) => ({
        key: queuedKey(call.callId, index),
        queued: true,
        questions: [question],
      }))
    : [{ key: call.callId, queued: false, questions: call.questions }];
}
