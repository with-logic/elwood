/**
 * The one shared `ElwoodActivityEvent` builder for unit tests: a minimal valid
 * transcript-sourced assistant message with non-progress fields overridden (PRD §5.4).
 */

import type { ElwoodActivityEvent } from "../../src/core/activity/index.ts";

export function activity(
  partial: Partial<Exclude<ElwoodActivityEvent, { readonly kind: "assistant_progress" }>> = {},
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
