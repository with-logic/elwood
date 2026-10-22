/** Derive queued-call acceptance from native and retained metadata (PRD §4). */
import type { Candidate } from "./candidate.ts";
import type { QuestionCall } from "./records.ts";

export function candidateCallAccepted(
  call: QuestionCall,
  candidates: ReadonlyMap<string, Candidate>,
): boolean {
  return (
    call.queued &&
    (call.accepted ||
      candidates
        .values()
        .some((candidate) => candidate.callId === call.callId && candidate.accepted))
  );
}
