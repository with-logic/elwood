/**
 * Builders for the Codex session's lifecycle warnings: the config.toml restore
 * outcomes after a model switch (PRD §5.3, C-CODEX-14), the clipboard-restore
 * failure after an image attach (§5.3, C-API-46), and a shutdown that signaled Codex
 * before it recorded the ended turn (§5.7, C-LIFE-13). Every warning is live-only
 * (§5.7) and content-free: `raw` carries a path, a fixed token, or a bounded errno
 * code, never config contents, clipboard data, or a raw error message.
 */

import type { ElwoodWarningEvent } from "../../core/types.ts";
import { restoreFailureRaw } from "../config/restore.ts";
import { CLIPBOARD_RESTORE_FAILED_MESSAGE } from "../images/clipboard.ts";

type RestoreWarning = Extract<
  ElwoodWarningEvent,
  { readonly code: "codex_default_model_persisted" }
>;

const restoreSkippedMessages = {
  interrupted:
    "Raw input took over the model picker; Elwood left changed model defaults in place because it could no longer attribute the change to its own operation.",
  skipped:
    "Codex persisted the picker selection as the user's default model, and Elwood skipped the restore because config.toml changed in other ways during the switch.",
  no_snapshot:
    "Codex persisted the picker selection as the user's default model in a config.toml that did not exist before the switch; Elwood left the new file in place because there was no prior config to restore.",
} as const;

/** No restore: concurrent edits, raw takeover, or no prior snapshot left the default in place. */
export function codexRestoreSkippedWarning(
  elwoodSessionId: string,
  outcome: keyof typeof restoreSkippedMessages,
  configPath: string,
): RestoreWarning {
  return {
    elwoodSessionId,
    agent: "codex",
    source: "lifecycle",
    code: "codex_default_model_persisted",
    severity: "warning",
    message: restoreSkippedMessages[outcome],
    raw: configPath,
  };
}

/**
 * Both the picker automation and the config restore failed: the primary error is
 * preserved to the caller, so the swallowed restore failure is surfaced as a bounded
 * diagnostic — otherwise the user gets no signal that config.toml may stay mutated.
 */
export function codexRestoreFailedWarning(
  elwoodSessionId: string,
  error: unknown,
  configPath: string,
): RestoreWarning {
  return {
    elwoodSessionId,
    agent: "codex",
    source: "lifecycle",
    code: "codex_default_model_persisted",
    severity: "warning",
    message:
      "Codex may have persisted the picker selection as the user's default model: the model switch failed and restoring config.toml also failed.",
    raw: restoreFailureRaw(configPath, error),
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

/** `stop`/`teardown` stopped waiting `waitMs` for the ended turn's record; shutdown proceeds. */
export function turnCommitWaitExpiredWarning(
  elwoodSessionId: string,
  waitMs: number,
): ElwoodWarningEvent {
  return {
    elwoodSessionId,
    agent: "codex",
    source: "lifecycle",
    code: "turn_commit_wait_expired",
    severity: "warning",
    message: `Elwood did not see Codex record the turn its Stop hook ended within ${waitMs / 1000} seconds of the shutdown request, and is shutting Codex down anyway. A resumed conversation may show that turn as interrupted.`,
    raw: "turn_commit_wait_expired",
  };
}
