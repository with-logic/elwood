/** Normalize authenticated Codex UPS and Stop identity for collection (PRD §5.8). */
import type { NativeTurnReader } from "../core/simple/turn-identity.ts";
import type { TurnBoundaryHook } from "../core/simple/turn-types.ts";
import type { CodexHookEventFor } from "./hooks/index.ts";

type SubmitIdentity = { readonly prompt: string; readonly turn_id: string };
type SubmitFields = Pick<Required<CodexHookEventFor<"UserPromptSubmit">>, keyof SubmitIdentity>;
const submitIdentityCheck: SubmitFields extends SubmitIdentity ? true : never = true;
void submitIdentityCheck;

function turnId(event: TurnBoundaryHook): string | undefined {
  return "turn_id" in event && typeof event.turn_id === "string" && event.turn_id.length > 0
    ? event.turn_id
    : undefined;
}

export const codexTurnIdentity: NativeTurnReader = {
  prepareAcceptance: (payload) => {
    // Payload is already sanitized by the physical paste writer: normalize once per owner.
    const submitted = payload.replace(/\r\n?/g, "\n").trim();
    return (event) =>
      event.hook_event_name === "UserPromptSubmit" && event.prompt === submitted
        ? turnId(event)
        : undefined;
  },
};
