/** Normalize prompt-correlated Codex hook identity for turn collection (PRD §5.8, C-API-48). */
import type { AcceptedTurnIdReader } from "../core/simple/turn-types.ts";
import type { CodexHookEventFor } from "./hooks/index.ts";

type SubmitIdentity = {
  readonly hook_event_name: "UserPromptSubmit";
  readonly prompt: string;
  readonly turn_id: string;
};
// Pin the real payload's declared keys and types: renaming a field must fail compilation.
type SubmitFields = Pick<Required<CodexHookEventFor<"UserPromptSubmit">>, keyof SubmitIdentity>;
const submitIdentityCheck: SubmitFields extends SubmitIdentity ? true : never = true;
void submitIdentityCheck;

export const readCodexAcceptedTurnId: AcceptedTurnIdReader = (event, prompt) =>
  event.hook_event_name === "UserPromptSubmit" &&
  event.prompt === prompt &&
  "turn_id" in event &&
  typeof event.turn_id === "string" &&
  event.turn_id.length > 0
    ? event.turn_id
    : undefined;
