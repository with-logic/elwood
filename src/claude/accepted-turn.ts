/**
 * Claude turn acceptance for ergonomic collection (PRD §5.8, C-API-59, C-CLAUDE-25): the submit
 * hook echoes the pasted payload as Claude's composer left it, inside the standalone
 * `<pasted_content>` envelope of §5.4 when Claude wrapped it (C-API-67).
 */
import { createAcceptanceSignal, type PasteEcho } from "../core/simple/acceptance-signal.ts";
import type { TurnBoundaryHook } from "../core/simple/turn-types.ts";
import type { ClaudeHookEventFor } from "./hooks/index.ts";
import { normalizeClaudePastedPayload as comparable } from "./input-text.ts";
import { claudePasteEnvelopeId, claudeSubmitPresentation } from "./pasted-content.ts";

// The native session id the envelope id derives from must stay a field of the real submit hook.
type SessionField = Pick<ClaudeHookEventFor<"UserPromptSubmit">, "session_id">;
const sessionFieldCheck: SessionField extends { readonly session_id: string } ? true : never = true;
void sessionFieldCheck;

function nativeSessionId(hookEvent: TurnBoundaryHook): string {
  return "session_id" in hookEvent && typeof hookEvent.session_id === "string"
    ? hookEvent.session_id
    : "";
}

/**
 * Whether a native Claude prompt is what Claude's composer makes of one paste of `payload`, as
 * the body of the session's standalone envelope or unwrapped.
 */
export const echoesClaudePaste: PasteEcho = (nativePrompt, payload, hookEvent) => {
  const envelopeId = claudePasteEnvelopeId(nativeSessionId(hookEvent));
  // The hook handler already presented this event's `user_message`; reuse it.
  const { text: echoed } = claudeSubmitPresentation(hookEvent, nativePrompt, envelopeId);
  return comparable(echoed) === comparable(payload);
};

export const claudeAcceptanceSignal = createAcceptanceSignal(echoesClaudePaste);
