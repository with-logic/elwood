/** Evidence shapes for Claude user prompt hooks and records (PRD §5.4, C-API-62, C-API-63). */
import type { UserPromptPresentation } from "../../core/activity/prompt-presentation.ts";
import type { UserPromptRecord } from "./user-record.ts";

export type UserPromptHookEvidence = {
  readonly path: string | undefined;
  readonly turnId: string;
  readonly pasteEnvelopeId?: string | undefined;
} & (
  | {
      readonly hasText: true;
      /** The native hook prompt, which tells a queued message from its running turn's prompt. */
      readonly prompt: string;
    }
  | { readonly hasText: false; readonly prompt?: string | undefined }
);

export type RecoveredUserPrompt = {
  readonly path: string;
  readonly turnId: string;
  readonly summary: UserPromptPresentation & {
    readonly kind: "user_message";
    readonly label: "user";
  };
};
export type RecordEvidence = UserPromptRecord & {
  readonly kind: "record";
  readonly retainedSizeBytes: number;
};
export type HookEvidence = { readonly kind: "hook"; readonly pasteEnvelopeId: string | undefined };
export type PromptEvidence = { readonly path: string } & (RecordEvidence | HookEvidence);
