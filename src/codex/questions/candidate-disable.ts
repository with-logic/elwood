/** Finish native retirement and diagnostics after PRD §4 candidate automation disables. */
import type { QuestionNotificationErrors } from "../../core/questions/notification-errors.ts";
import type { QuestionRegistry } from "../../core/questions/registry.ts";

export function finishCandidateDisable(
  registry: QuestionRegistry,
  notifications: QuestionNotificationErrors,
  nativeKeys: readonly string[],
  onDisabled: (() => void) | undefined,
): void {
  for (const nativeKey of nativeKeys) {
    const request = registry.find(nativeKey);
    if (request) notifications.capture(() => registry.close(request.id, "unavailable"));
  }
  try {
    onDisabled?.();
  } catch {
    // Diagnostic failure must not interrupt permanent automation disablement.
  }
}
