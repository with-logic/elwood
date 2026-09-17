/**
 * Builds the best-effort `agent_update_failed` warning (PRD §9.2, C-LIFE-11) shared by both
 * adapter preflights. A `claude update` / `codex update` that fails is contained (never fatal
 * when the installed CLI is compatible) and surfaced as this live warning with the diagnostics
 * the PRD allows — the installed version in use, the update probe's errno, and the updater's own
 * stderr capped at 2 KB in `raw` (the CLI updater's output, never session transcripts or
 * prompts). Contention instead reports that the local update was skipped.
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
 * Build the warning from the contained update error. `installedVersion` is the parsed version the
 * session will actually run (the preflight re-read it after the failed update). `errorCode` is the
 * update probe's allowlisted `errno` (e.g. `ETIMEDOUT`) when present, else a generic token.
 */
export function updateFailedWarning(
  agent: ElwoodAgentKind,
  installedVersion: string,
  error: unknown,
): UpdateFailedWarning {
  const details = error instanceof ElwoodError ? error.details : {};
  const errno = typeof details["errno"] === "string" ? details["errno"] : undefined;
  const stderr = typeof details["stderr"] === "string" ? details["stderr"] : "";
  const activeOwner = details["updateReason"] === "active_owner";
  return {
    agent,
    source: "lifecycle",
    code: "agent_update_failed",
    severity: "warning",
    message: activeOwner
      ? `\`${agent} update\` skipped: another updater is still active; continuing with the installed CLI ${installedVersion}.`
      : `\`${agent} update\` failed; continuing with the installed CLI ${installedVersion}.`,
    installedVersion,
    errorCode: activeOwner ? "update_active" : (errno ?? "update_failed"),
    raw: stderr.slice(0, maxStderr),
  };
}
