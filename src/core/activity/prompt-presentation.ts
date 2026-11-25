/** User message presentation and optional native paste evidence (PRD §5.4, C-API-67). */
export type ElwoodPromptProvenance = {
  readonly origin: "unknown";
  readonly input: "pasted";
};

type PlainPrompt = { readonly promptProvenance?: never; readonly nativePrompt?: never };
type NativePaste = {
  readonly promptProvenance: ElwoodPromptProvenance;
  readonly nativePrompt: string;
};
export type UserPromptPresentation = { readonly text: string } & (PlainPrompt | NativePaste);

/** Plain hook messages are shared across adapters. Native paste evidence requires Claude. */
export type UserMessageActivity = {
  readonly kind: "user_message";
  readonly label: "user";
} & UserPromptPresentation &
  (PlainPrompt | { readonly agent: "claude" }) &
  (
    | { readonly source: "hook"; readonly hookEventName: "UserPromptSubmit" }
    | {
        readonly agent: "claude";
        readonly source: "transcript";
        readonly transcriptPath: string;
        readonly turnId: string;
      }
  );
