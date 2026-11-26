/** Codex's workspace trust type specializations (PRD §5.13, C-ATTN-07/08). */
import type {
  ElwoodDialogEvent as DialogEvent,
  ElwoodDialogRequest as DialogRequest,
  ElwoodTrustDialogRequest,
} from "../../core/dialogs/types.ts";

export type { WorkspaceTrustTarget } from "../../core/dialogs/types.ts";
/** Any Codex dialog request: what the session lists and its `dialog` events carry. */
export type ElwoodDialogRequest = DialogRequest<"codex">;
/** The trust request alone, which only the trust discovery, writer and retire paths hold. */
export type CodexTrustDialogRequest = ElwoodTrustDialogRequest<"codex">;
export type ElwoodDialogEvent = DialogEvent<"codex">;
