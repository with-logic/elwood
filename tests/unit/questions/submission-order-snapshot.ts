/** Capture public and native ownership at a completed submission checkpoint (PRD §4). */
import type {
  ElwoodQuestionEvent,
  ElwoodQuestionRequest,
} from "../../../src/core/questions/types.ts";
import type { controllerHarness } from "./controller-helpers.ts";

export function submissionOrderSnapshot(
  h: ReturnType<typeof controllerHarness>,
  request: ElwoodQuestionRequest,
  observed: readonly ElwoodQuestionEvent[],
) {
  return {
    answerable: h.questions.registry.get(request.id),
    requests: h.questions.list(),
    nativeReservation: h.questions.registry.find("native"),
    pending: h.questions.registry.hasPending(),
    blocksInput: h.questions.blocksInput(),
    closed: observed.filter((event) => event.phase === "closed"),
  };
}
