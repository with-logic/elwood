/**
 * Claude turn acceptance for ergonomic collection (PRD §5.8, C-API-59, C-CLAUDE-25): the submit
 * hook echoes the pasted payload as Claude's composer left it, inside the standalone
 * `<pasted_content>` envelope of §5.4 when Claude wrapped it (C-API-67).
 */
import {
  createAcceptanceSignal,
  type PasteEcho,
  registerAcceptanceSignal,
} from "../core/simple/acceptance-signal.ts";
import type { TurnBoundaryHook } from "../core/simple/turn-types.ts";
import { claudePasteEnvelopeId, claudePromptPresentation } from "./pasted-content.ts";

function nativeSessionId(hookEvent: TurnBoundaryHook): string {
  return "session_id" in hookEvent && typeof hookEvent.session_id === "string"
    ? hookEvent.session_id
    : "";
}

/**
 * Compared text ignores what Claude's composer changes at the end and around a `<`. A prompt
 * Claude does not wrap loses its trailing whitespace, and a wrapped body loses one trailing
 * newline. Claude's `<\` escape of a look-alike tag cannot be undone exactly: it skips a `<`
 * that a backslash already follows and also escapes look-alike spellings, so every `<\` reads
 * as `<` here.
 */
function comparable(text: string): string {
  return text.replaceAll("<\\", "<").trimEnd();
}

/**
 * Whether a native Claude prompt is what Claude's composer makes of one paste of `payload`:
 * the payload with CRLF and CR as LF and each tab as four spaces, as the body of the session's
 * standalone envelope or unwrapped.
 */
export const echoesClaudePaste: PasteEcho = (nativePrompt, payload, hookEvent) => {
  const envelopeId = claudePasteEnvelopeId(nativeSessionId(hookEvent));
  const { text } = claudePromptPresentation(nativePrompt, envelopeId);
  const pasted = payload.replace(/\r\n?/gu, "\n").replace(/\t/gu, "    ");
  return comparable(text) === comparable(pasted);
};

export const claudeAcceptanceSignal = createAcceptanceSignal(echoesClaudePaste);

/** Called once per live Claude session, before any turn can run on it. */
export function registerClaudeAcceptanceSignal(session: object): void {
  registerAcceptanceSignal(session, claudeAcceptanceSignal);
}
