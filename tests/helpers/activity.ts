/** Shared assistant-message fixture; structured question events use their native producers (PRD §5.4). */
import type { ElwoodActivityEvent } from "../../src/core/activity/index.ts";

type FixtureActivity = Omit<
  Exclude<ElwoodActivityEvent, { kind: "question" | "assistant_progress" }>,
  "speed"
> & { readonly speed?: never };

export function activity(partial: Partial<FixtureActivity> = {}): FixtureActivity {
  return {
    elwoodSessionId: "s1",
    agent: "claude",
    source: "transcript",
    kind: "assistant_message",
    label: "assistant",
    ...partial,
  };
}
