/** Codex's workspace trust request specialization (PRD §5.13, C-ATTN-07). */
import type { ElwoodDialogRequest as DialogRequest } from "../../core/dialogs/types.ts";

export type { WorkspaceTrustTarget } from "../../core/dialogs/types.ts";
export type ElwoodDialogRequest = DialogRequest<"codex">;
