/**
 * Builds the best-effort `agent_update_failed` warning (PRD §9.2, C-LIFE-11) shared by both
 * adapter preflights. A `claude update` / `codex update` that fails is contained (never fatal
 * when the installed CLI is compatible) and surfaced as this live warning with the diagnostics
 * the PRD allows — the installed version in use, the update probe's errno, and the updater's own
 * stderr capped at 2 KB in `raw` (the CLI updater's output, never session transcripts or
 * prompts). Contention is not a failed update and reports differently: an error carrying
 * `updateReason: "active_owner"` — another process held the update lease until this caller's
 * wait expired — becomes `errorCode: "update_active"` with a message saying the update was
 * skipped, and no diagnostics, because no local updater ran to produce an errno or stderr.
 */

import type { ElwoodAgentKind } from "../activity/index.ts";
import { ElwoodError } from "../errors.ts";
import type { AgentUpdateFailedWarning } from "./lifecycle.ts";

/**
 * `Omit` that DISTRIBUTES over a union (`W extends unknown` triggers distribution), unlike the
 * built-in `Omit`, which collapses `A | B` into a single merged object and loses the discriminant.
 * Preflight warning types are unions, so they must use this to stay discriminable after `omit`.
 */
export type DistributiveOmit<W, K extends PropertyKey> = W extends unknown ? Omit<W, K> : never;

/** The `agent_update_failed` warning without `elwoodSessionId` (attached when emitted). */
export type UpdateFailedWarning = Omit<AgentUpdateFailedWarning, "elwoodSessionId">;

// Cap on the stderr carried in the warning's `raw`, so a hostile/verbose updater cannot flood a
// warning payload. The probe layer already bounds captured output; this is a second, tighter cap.
const maxStderr = 2_000;

/**
 * Reasons an update was skipped rather than attempted, and how each reads to a user. A
 * skipped update carries no errno or updater stderr, because no local updater ran. Both
 * reach the consumer as `errorCode: "update_active"` and differ only in timing:
 * `active_owner` follows the full 60-second contention wait, while `cleanup_pending` is
 * immediate, because a surviving updater group may outlive any bound worth waiting out.
 */
const skippedUpdates: ReadonlyMap<unknown, string> = new Map([
  ["active_owner", "another updater is still active"],
  ["cleanup_pending", "another updater's process group has not exited"],
]);

/**
 * Build the warning from the contained update error. `installedVersion` is the parsed version the
 * session will actually run (the preflight re-read it after the failed update). `errorCode` is the
 * update probe's allowlisted `errno` (e.g. `ETIMEDOUT`) when present, else a generic token.
 *
 * An error carrying `updateReason: "active_owner"` is contention, not failure: another process
 * held the update lease until this caller's wait expired, so no local update command ran. That
 * yields `errorCode: "update_active"` and a message saying the update was skipped, with empty
 * diagnostics — there is no errno or updater stderr to report, and retrying is the caller's
 * next startup, not something to drive off this warning.
 */
export function buildUpdateWarning(
  agent: ElwoodAgentKind,
  installedVersion: string,
  error: unknown,
): UpdateFailedWarning {
  const details = error instanceof ElwoodError ? error.details : {};
  const errno = typeof details["errno"] === "string" ? details["errno"] : undefined;
  const stderr = typeof details["stderr"] === "string" ? details["stderr"] : "";
  const skipped = skippedUpdates.get(details["updateReason"]);
  return {
    agent,
    source: "lifecycle",
    code: "agent_update_failed",
    severity: "warning",
    message:
      skipped === undefined
        ? `\`${agent} update\` failed; continuing with the installed CLI ${installedVersion}.`
        : `\`${agent} update\` skipped: ${skipped}; continuing with the installed CLI ${installedVersion}.`,
    installedVersion,
    errorCode: skipped === undefined ? (errno ?? "update_failed") : "update_active",
    raw: stderr.slice(0, maxStderr),
  };
}
