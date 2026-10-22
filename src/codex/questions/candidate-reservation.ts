/** Preserve native question reservations across metadata mirrors (PRD §4). */
import type { QuestionRegistry } from "../../core/questions/registry.ts";
import type { Candidate } from "./candidate.ts";
import type { QuestionBudget } from "./limits.ts";

export function hasCandidateReservation(
  nativeKey: string,
  candidate: Candidate | undefined,
  budget: QuestionBudget,
  registry: QuestionRegistry,
): boolean {
  return (
    budget.hasRetired(nativeKey) ||
    registry.isRetired(nativeKey) ||
    Boolean(candidate && (candidate.submitting || candidate.awaitingNative))
  );
}
