/** Shared assistant-message fixture; structured question events use their native producers (PRD §5.4). */
import type { ElwoodActivityEvent } from "../../src/core/activity/index.ts";

type FixtureActivity = Omit<
  Exclude<
    ElwoodActivityEvent,
    { kind: "question" | "assistant_progress" | "unrecognized_startup" }
  >,
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
  if (kind === "user_message" && fields.source === "transcript") {
    return {
      ...base,
      kind,
      agent: "claude",
      source: "transcript",
      label: "user",
      transcriptPath: fields.transcriptPath ?? "/fixture.jsonl",
      turnId: fields.turnId ?? "native-prompt",
      text: fields.text ?? "fixture prompt",
    } as const;
  }
  return kind === "user_message"
    ? ({
        ...base,
        kind,
        source: "hook",
        hookEventName: "UserPromptSubmit",
        label: "user",
        text: fields.text ?? "fixture prompt",
      } as const)
    : { ...base, kind };
}
