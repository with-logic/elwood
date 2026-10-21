/** Shared assistant-message fixture; structured question events use their native producers (PRD §5.4). */
import type { ElwoodActivityEvent } from "../../src/core/activity/index.ts";
export function activity(
  partial: Partial<Exclude<ElwoodActivityEvent, { kind: "question" | "assistant_progress" }>> = {},
): ElwoodActivityEvent {
  return {
    elwoodSessionId: "s1",
    agent: "claude",
    source: "transcript",
    kind: "assistant_message",
    label: "assistant",
    ...partial,
  };
}
