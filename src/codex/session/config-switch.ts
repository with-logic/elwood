/**
 * One Codex session's `setModel` config transaction: the snapshot, the picker flow, and the
 * compare-and-swap restore of THAT session's config.toml, with the restore warnings.
 * Implements PRD §5.3 setModel restore and C-CODEX-14.
 */

import { isPickerIntervention } from "../../core/models/intervention.ts";
import type { ElwoodWarningEvent } from "../../core/types.ts";
import { restoreCodexConfig, snapshotCodexConfig } from "../config/restore.ts";
import { runCodexModelSwitch } from "../config/transaction.ts";
import { codexRestoreFailedWarning, codexRestoreSkippedWarning } from "./warnings.ts";

export type CodexConfigSwitchSession = {
  readonly elwoodSessionId: string;
  /** The config.toml this session's Codex uses, fixed at launch. */
  readonly configPath: string;
  readonly waitForCliExit: () => Promise<unknown> | undefined;
  readonly emitWarnings: (warnings: readonly ElwoodWarningEvent[]) => void;
};

/**
 * Restores the user's config default after picker changes; the live CLI retains its
 * selection. The process-wide transaction lock prevents interleaved snapshots and restores
 * even when automation rejects after Codex writes (C-CODEX-14).
 */
export function switchCodexModel(
  session: CodexConfigSwitchSession,
  flow: () => Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  const { elwoodSessionId, configPath: path } = session;
  return runCodexModelSwitch({
    snapshot: () => snapshotCodexConfig(path),
    apply: flow,
    waitForCliExit: session.waitForCliExit,
    // The picker deadline includes this lock wait. Once acquired, the transaction
    // owns config.toml until its abort handling and restore finish.
    cancel: { signal, error: () => signal.reason },
    restore: (snapshot) => {
      // Raw input that took over the picker revokes restore authority.
      const outcome = isPickerIntervention(signal.reason)
        ? snapshotCodexConfig(path) === snapshot
          ? "unchanged"
          : "interrupted"
        : restoreCodexConfig({ path, snapshot });
      if (outcome === "restored" || outcome === "unchanged") return;
      session.emitWarnings([codexRestoreSkippedWarning(elwoodSessionId, outcome, path)]);
    },
    onRestoreError: (error) =>
      session.emitWarnings([codexRestoreFailedWarning(elwoodSessionId, error, path)]),
  });
}
