/** Publish native candidate definitions within the PRD §4 notification boundary. */
import type { QuestionNotificationErrors } from "../../core/questions/notification-errors.ts";
import type { QuestionRegistry } from "../../core/questions/registry.ts";
import type { Candidate } from "./candidate.ts";

/** The caller owns the outer notification batch and candidate publication bookkeeping. */
export function publishCandidateRequest(
  registry: QuestionRegistry,
  notifications: QuestionNotificationErrors,
  candidate: Candidate,
): boolean {
  notifications.capture(() => {
    registry.publish(
      candidate.nativeKey,
      candidate.queued ? "queued" : "blocking",
      candidate.questions.map((question) => question.definition),
    );
  });
  return registry.find(candidate.nativeKey) !== undefined;
}
