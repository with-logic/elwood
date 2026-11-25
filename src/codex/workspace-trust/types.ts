/** Codex's workspace trust type specializations (PRD §5.13, C-ATTN-07/08). */
import type {
  ElwoodDialogEvent as DialogEvent,
  ElwoodDialogRequest as DialogRequest,
} from "../../core/dialogs/types.ts";

export type { WorkspaceTrustTarget } from "../../core/dialogs/types.ts";
export type ElwoodDialogRequest = DialogRequest<"codex">;
export type ElwoodDialogEvent = DialogEvent<"codex">;
