/** Preserve native question identity discriminants in PRD §4 candidate groups. */
import type { ModalNativeQuestion, QueuedNativeQuestion } from "./definitions.ts";
import { QuestionLimitError, questionMetadataLimitBytes } from "./limits.ts";
import { type QuestionCall, queuedKey } from "./records.ts";

type CandidateGroup = { readonly nativeKey: string } & (
  | { readonly queued: false; readonly questions: readonly ModalNativeQuestion[] }
  | { readonly queued: true; readonly questions: readonly QueuedNativeQuestion[] }
);
export type Candidate = CandidateGroup & {
  readonly callId: string;
  readonly submitting: boolean;
  readonly published: boolean;
  readonly bytes: number;
} & (
    | { readonly queued: false; readonly accepted: false }
    | { readonly queued: true; readonly accepted: boolean }
  );
export type QueuedCandidate = Extract<Candidate, { readonly queued: true }>;
export type AcceptedQueuedCandidate = QueuedCandidate & { readonly accepted: true };

export function createCandidate(
  group: CandidateGroup,
  callId: string,
  accepted: boolean,
  bytes: number,
): Candidate {
  const state = { callId, submitting: false, published: false, bytes };
  return group.queued ? { ...group, ...state, accepted } : { ...group, ...state, accepted: false };
}
export function candidateGroups(call: QuestionCall): readonly CandidateGroup[] {
  if (!call.queued) return [{ nativeKey: call.callId, queued: false, questions: call.questions }];
  // Expanding a long ID into every key must not allocate beyond the retained-byte
  // budget before the store can reject it. Every candidate retains at least its key.
  const firstKeyBytes = Buffer.byteLength(queuedKey(call.callId, 0));
  let expandedKeyBytes = 0;
  for (let index = 0; index < call.questions.length; index++) {
    expandedKeyBytes += firstKeyBytes + String(index).length - 1;
    if (expandedKeyBytes > questionMetadataLimitBytes) throw new QuestionLimitError();
  }
  return call.questions.map((question, index) => ({
    nativeKey: queuedKey(call.callId, index),
    queued: true,
    questions: [question],
  }));
}
