/** Build precise native transcript observations for private Codex tests (PRD §4). */
import type { ElwoodActivityEvent } from "../../../src/core/activity/index.ts";
import { activity } from "../../helpers/activity.ts";

export function nativeTranscriptEvent(
  raw: unknown,
  elwoodSessionId: string,
): ElwoodActivityEvent & { readonly kind: "other" } {
  return {
    ...activity({ agent: "codex", elwoodSessionId, source: "transcript", label: "native", raw }),
    kind: "other",
  };
}
