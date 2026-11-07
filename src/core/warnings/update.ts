/**
 * Builds best-effort `agent_update_failed` warnings for adapter preflights (PRD §9.2,
 * C-LIFE-11). Attempted updates report their allowed diagnostics: the installed version,
 * probe exit status and errno, and updater stderr capped at 2 KB in `raw`.
 * Local prerequisite-verification refusals and known peer verification refusals instead
 * report that the update was skipped before invocation, without updater diagnostics or
 * verifier output. Contention reports `update_active` without updater diagnostics.
 * A login-shell failure before invocation reports `login_shell_failed` with empty `raw`,
 * withholding profile startup output.
 */

import type { ElwoodAgentKind } from "../activity/index.ts";
import { ElwoodError } from "../errors.ts";
import { probeRefusalContext } from "../probe-refusal.ts";
import { UpdateVerificationFailure } from "../update-verification.ts";
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
 * `active_owner` follows the full 165-second contention wait, while `cleanup_pending` is
 * immediate, because a surviving updater group may outlive any bound worth waiting out.
 */
const skippedUpdates: ReadonlyMap<unknown, string> = new Map([
  ["active_owner", "another updater is still active"],
  ["cleanup_pending", "another updater's process group has not exited"],
]);

/**
 * Build a contained update warning using the installed version the session will run.
 * Attempted updates report the probe's allowlisted errno or a generic failure token.
 * Local prerequisite-verification and known peer refusals report `update_failed` with
 * fixed skipped-before-invocation wording and no diagnostics. Contention instead reports
 * `update_active`; a pre-command login-shell failure reports `login_shell_failed`.
 */
export function buildUpdateWarning(
  agent: ElwoodAgentKind,
  installedVersion: string,
  error: unknown,
): UpdateFailedWarning {
  const isVerificationRefusal =
    error instanceof UpdateVerificationFailure ||
    (error instanceof ElwoodError && error.details["updateReason"] === "peer_verification_refused");
  const details = !isVerificationRefusal && error instanceof ElwoodError ? error.details : {};
  const errno = typeof details["errno"] === "string" ? details["errno"] : undefined;
  const stderr = typeof details["stderr"] === "string" ? details["stderr"] : "";
  const exitStatus = typeof details["exitStatus"] === "number" ? details["exitStatus"] : undefined;
  const skipped = skippedUpdates.get(details["updateReason"]);
  const refusal = probeRefusalContext(error);
  let message: string;
  if (isVerificationRefusal) {
    message = `\`${agent} update\` skipped before invocation; continuing with the installed CLI ${installedVersion}.`;
  } else if (skipped !== undefined) {
    message = `\`${agent} update\` skipped: ${skipped}; continuing with the installed CLI ${installedVersion}.`;
  } else if (typeof refusal === "string") {
    message = `${refusal} Continuing with the installed CLI ${installedVersion}.`;
  } else {
    message = `\`${agent} update\` failed; continuing with the installed CLI ${installedVersion}.`;
  }
  return {
    agent,
    source: "lifecycle",
    code: "agent_update_failed",
    severity: "warning",
    message,
    installedVersion,
    errorCode: skipped === undefined ? failureCode(details, errno) : "update_active",
    raw: stderr.slice(0, maxStderr),
    ...(exitStatus === undefined ? {} : { exitStatus }),
  };
}

/**
 * A confirmed pre-command shell refusal reports `login_shell_failed`; an unobserved command
 * start retains the probe's errno or generic update failure (§9.2, C-PERF-05).
 */
function failureCode(
  details: Readonly<Record<string, unknown>>,
  errno: string | undefined,
): string {
  if (details["phase"] === "login_shell") return "login_shell_failed";
  return errno ?? "update_failed";
}
