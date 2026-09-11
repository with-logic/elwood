/**
 * Builders for the Codex session's lifecycle warnings: the config.toml restore
 * outcomes after a model switch (PRD §5.3, C-CODEX-14) and the clipboard-restore
 * failure after an image attach (§5.3, C-API-46). Every warning is live-only
 * (§5.7) and content-free: `raw` carries a path or a bounded errno code, never
 * config contents, clipboard data, or a raw error message.
 */

import type { ElwoodWarningEvent } from "../../core/types.ts";
import { codexConfigPath, restoreFailureRaw } from "../config/restore.ts";
import { CLIPBOARD_RESTORE_FAILED_MESSAGE } from "../images/clipboard.ts";

type RestoreWarning = Extract<
  ElwoodWarningEvent,
  { readonly code: "codex_default_model_persisted" }
>;

const restoreSkippedMessages = {
  skipped:
    "Codex persisted the picker selection as the user's default model, and Elwood skipped the restore because config.toml changed in other ways during the switch.",
  no_snapshot:
    "Codex persisted the picker selection as the user's default model in a config.toml that did not exist before the switch; Elwood left the new file in place because there was no prior config to restore.",
} as const;

/** The restore was not applied: the file changed in other ways, or there was nothing to restore. */
export function codexRestoreSkippedWarning(
  elwoodSessionId: string,
  outcome: keyof typeof restoreSkippedMessages,
): RestoreWarning {
  return {
    elwoodSessionId,
    agent: "codex",
    source: "lifecycle",
    code: "codex_default_model_persisted",
    severity: "warning",
    message: restoreSkippedMessages[outcome],
    raw: codexConfigPath(),
  };
}

/**
 * Both the picker automation and the config restore failed: the primary error is
 * preserved to the caller, so the swallowed restore failure is surfaced as a bounded
 * diagnostic — otherwise the user gets no signal that config.toml may stay mutated.
 */
export function codexRestoreFailedWarning(elwoodSessionId: string, error: unknown): RestoreWarning {
  return {
    elwoodSessionId,
    agent: "codex",
    source: "lifecycle",
    code: "codex_default_model_persisted",
    severity: "warning",
    message:
      "Codex may have persisted the picker selection as the user's default model: the model switch failed and restoring config.toml also failed.",
    raw: restoreFailureRaw(codexConfigPath(), error),
  };
}

/** The clipboard text could not be restored after an image attach (content-free). */
export function clipboardRestoreFailedWarning(elwoodSessionId: string): ElwoodWarningEvent {
  return {
    elwoodSessionId,
    agent: "codex",
    source: "lifecycle",
    code: "clipboard_restore_failed",
    severity: "warning",
    message: CLIPBOARD_RESTORE_FAILED_MESSAGE,
    raw: "clipboard_restore_failed",
  };
}
