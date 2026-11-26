/**
 * Codex's workspace trust type specializations (PRD §5.13, C-ATTN-07/08). Types for every
 * Codex dialog, update offers included, are the core ones, whose agent defaults to Codex.
 */
import type { ElwoodTrustDialogRequest } from "../../core/dialogs/types.ts";

export type { WorkspaceTrustTarget } from "../../core/dialogs/types.ts";
/** The trust request alone, which only the trust discovery, writer and retire paths hold. */
export type CodexTrustDialogRequest = ElwoodTrustDialogRequest<"codex">;
