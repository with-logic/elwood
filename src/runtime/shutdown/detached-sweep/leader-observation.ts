/**
 * Freezes graceful-watch leader authority (PRD §5.3, C-LIFE-10). `ps lstart` has
 * second resolution; a first observation within that second cannot exclude PID reuse.
 */
import { errnoCode, isErrnoToken } from "../../../core/errors.ts";
import { type ProcessEntry, processIdentity } from "../process-table.ts";

export type LeaderObservation =
  | { readonly kind: "observed"; readonly identity: string }
  | { readonly kind: "gone" }
  | { readonly kind: "refused"; readonly error: Error };

export const PROCESS_START_TIME_RESOLUTION_MS = 1_000;

/** Authorize only an older, parseable original group leader; retain safe read errno only. */
export function observeLeader(
  row: ProcessEntry | undefined,
  leaderPid: number,
  readStartedAtEpochMs: number,
): LeaderObservation {
  if (row === undefined) return { kind: "gone" };
  const started = Date.parse(`${row.startedAt} UTC`);
  if (
    row.pgid !== leaderPid ||
    !Number.isFinite(started) ||
    started + PROCESS_START_TIME_RESOLUTION_MS > readStartedAtEpochMs
  )
    return {
      kind: "refused",
      error: new Error("First leader identity is not safely distinguishable."),
    };
  return { kind: "observed", identity: processIdentity(row) };
}

/** Preserve safe errno, never arbitrary raw process-table diagnostics. */
export function refuseLeaderObservation(readError: unknown): LeaderObservation {
  const code = errnoCode(readError);
  return {
    kind: "refused",
    error: Object.assign(
      new Error("First leader process-table read failed."),
      isErrnoToken(code) ? { code } : {},
    ),
  };
}
