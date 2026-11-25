/** Associate Claude's authenticated submit with the shared API ledger (C-API-71). */
import type { activityFromClaudeHook, ElwoodActivityEvent } from "../../core/activity/index.ts";
import { claudeApiUserActivity } from "../../core/activity/prompt-presentation.ts";
import type { PromptSubmissions } from "../../runtime/session/prompt-submissions.ts";
import type { ClaudeHookEventFor } from "../hooks/index.ts";

export function associateClaudePrompt(
  ledger: PromptSubmissions | undefined,
  event: ClaudeHookEventFor<"UserPromptSubmit">,
  displayed: ReturnType<typeof activityFromClaudeHook>,
  visible: boolean,
): ElwoodActivityEvent {
  const body = visible && displayed.kind === "user_message" ? displayed.text : undefined;
  const prompt = ledger?.observeNativeSubmit({
    turnId: displayed.turnId ?? "",
    nativePrompt: body === undefined ? undefined : event.prompt,
    displayedNativeText: body,
  });
  return prompt ? claudeApiUserActivity(displayed.elwoodSessionId, event, prompt) : displayed;
}
