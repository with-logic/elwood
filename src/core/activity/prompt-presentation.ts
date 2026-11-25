/** User message presentation and optional native paste evidence (PRD §5.4, C-API-67). */
import type { CodexHookEventFor } from "../../codex/hooks/index.ts";
import { hookActivityBase } from "./meta.ts";

type NativePasteProvenance = {
  readonly origin: "unknown";
  readonly input: "pasted";
};

type ApiProvenance = { readonly origin: "api"; readonly input: "pasted" };
export type ElwoodPromptProvenance = NativePasteProvenance | ApiProvenance;

export type NoPromptEvidence = {
  readonly sendId?: never;
  readonly promptProvenance?: never;
  readonly nativePrompt?: never;
};
type NativePaste = {
  readonly sendId?: never;
  readonly promptProvenance: NativePasteProvenance;
  readonly nativePrompt: string;
};
export type UserPromptPresentation = { readonly text: string } & (NoPromptEvidence | NativePaste);

export type ApiPromptPresentation = {
  readonly text: string;
  readonly turnId: string;
  readonly sendId?: string;
  readonly nativePrompt: string;
  readonly promptProvenance: ApiProvenance;
};

/** Native paste evidence requires Claude. API correlation has a separate hook projection. */
export type NativeUserMessageActivity = {
  readonly kind: "user_message";
  readonly label: "user";
} & UserPromptPresentation &
  (NoPromptEvidence | { readonly agent: "claude" }) &
  (
    | ({ readonly source: "hook"; readonly hookEventName: "UserPromptSubmit" } & (
        | { readonly agent: "claude" }
        | { readonly agent: "codex" }
      ))
    | {
        readonly agent: "claude";
        readonly source: "transcript";
        readonly transcriptPath: string;
        readonly turnId: string;
      }
  );

export type CodexApiUserMessageActivity = ApiPromptPresentation & {
  readonly agent: "codex";
  readonly kind: "user_message";
  readonly label: "user";
  readonly source: "hook";
  readonly hookEventName: "UserPromptSubmit";
  readonly final?: never;
};

export function codexApiUserActivity(
  elwoodSessionId: string,
  event: CodexHookEventFor<"UserPromptSubmit">,
  prompt: ApiPromptPresentation,
): ReturnType<typeof hookActivityBase> & CodexApiUserMessageActivity {
  return {
    ...hookActivityBase("codex", elwoodSessionId, event),
    ...prompt,
    agent: "codex",
    kind: "user_message",
    source: "hook",
    hookEventName: "UserPromptSubmit",
    label: "user",
  };
}
