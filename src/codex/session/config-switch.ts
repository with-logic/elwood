/**
 * One Codex session's `setModel` config transaction: the snapshot, the picker flow, and the
 * compare-and-swap restore of THAT session's config.toml, with the restore warnings.
 * Implements PRD §5.3 setModel restore, C-CODEX-14, C-CODEX-24, and C-CODEX-25.
 */

import { isCallerInputIntervention } from "../../core/models/intervention.ts";
import type { ElwoodWarningEvent } from "../../core/types.ts";
import { currentCodexConfig, restoreCodexConfig, snapshotCodexConfig } from "../config/restore.ts";
import { runCodexModelSwitch } from "../config/transaction.ts";
import { codexRestoreFailedWarning, codexRestoreSkippedWarning } from "./warnings.ts";

export type CodexConfigSwitchSession = {
  readonly elwoodSessionId: string;
  /** The config.toml of the `CODEX_HOME` this session's Codex runs with (C-CODEX-24). */
  readonly resolveConfigPath: (signal: AbortSignal) => Promise<string>;
  readonly waitForCliExit: () => Promise<unknown> | undefined;
  readonly emitWarnings: (warnings: readonly ElwoodWarningEvent[]) => void;
};

/**
 * Restores the user's config default after picker changes; the live CLI retains its
 * selection. The config file's transaction lock prevents interleaved snapshots and restores
 * even when automation rejects after Codex writes (C-CODEX-14).
 */
export async function switchCodexModel(
  session: CodexConfigSwitchSession,
  flow: () => Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  // Known before the picker runs: a switch whose config cannot be named is never made. A
  // switch that starts before the launch shell has written its report waits for it.
  const path = await session.resolveConfigPath(signal);
  const { elwoodSessionId } = session;
  await runCodexModelSwitch({
    path,
    snapshot: () => snapshotCodexConfig(path),
    apply: flow,
    waitForCliExit: session.waitForCliExit,
    // The picker deadline includes this lock wait. Once acquired, the transaction
    // owns config.toml until its abort handling and restore finish.
    cancel: { signal, error: () => signal.reason },
    restore: (snapshot) => {
      // Raw input that took over the picker revokes restore authority.
      const outcome = isCallerInputIntervention(signal.reason)
        ? currentCodexConfig(path) === snapshot
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
