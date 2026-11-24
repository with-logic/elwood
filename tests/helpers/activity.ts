/** Shared assistant-message fixture; structured question events use their native producers (PRD §5.4). */
import type { ElwoodActivityEvent } from "../../src/core/activity/index.ts";

type FixtureActivity = Omit<
  Exclude<ElwoodActivityEvent, { kind: "question" | "assistant_progress" }>,
  "speed" | "tokenUsage" | "rateLimits" | "subagent"
> & { readonly speed?: never };

export function activity(partial: Partial<FixtureActivity> = {}) {
  const { kind = "assistant_message", ...fields } = partial;
  const base = {
    elwoodSessionId: "s1",
    agent: "claude",
    source: "transcript",
    label: "assistant",
    ...fields,
  } as const;
  return kind === "user_message"
    ? { ...base, kind, text: fields.text ?? "fixture prompt" }
    : { ...base, kind };
}
