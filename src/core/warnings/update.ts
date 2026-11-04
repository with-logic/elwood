/**
 * Builds the best-effort `agent_update_failed` warning (PRD §9.2, C-LIFE-11) shared by both
 * adapter preflights. A `claude update` / `codex update` that fails is contained (never fatal
 * when the installed CLI is compatible) and surfaced as this live warning with the diagnostics
 * the PRD allows — the installed version in use, the update probe's exit status and errno, and
 * the updater's own stderr capped at 2 KB in `raw` (the CLI updater's output, never session transcripts or
 * prompts). Contention is not a failed update and reports differently: an error carrying
 * `updateReason: "active_owner"` — another process held the update lease until this caller's
 * wait expired — becomes `errorCode: "update_active"` with a message saying the update was
 * skipped, and no diagnostics, because no local updater ran to produce an errno or stderr.
 * The user's login shell can also fail before the update command runs (§9.2): that reports
 * `errorCode: "login_shell_failed"` with empty `raw`, since its stderr would be only the
 * profile's startup output.
 * Confirmed no-attempt outcomes use `update_not_started`, without updater diagnostics;
 * known contention and pending cleanup take precedence and retain `update_active`.
 */

import type { ElwoodAgentKind } from "../activity/index.ts";
import { ElwoodError } from "../errors.ts";
import { probeRefusalContext } from "../probe-refusal.ts";
import type { AgentUpdateFailedWarning } from "./lifecycle.ts";
import { isUpdateSkipReason, updateSkipMessages } from "./update-skips.ts";
import { isUnconfirmedPeerUpdate } from "./update-unconfirmed.ts";

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
 * session will actually run (the preflight re-read it after the failed update). `errorCode` is
 * `login_shell_failed` when the login shell failed before the update ran, else the update
 * probe's allowlisted `errno` (e.g. `ETIMEDOUT`) when present, else a generic token.
 * `notStarted` confirms no updater invocation: verification diagnostics are omitted and
 * the code is `update_not_started`, unless the existing contention code takes precedence.
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
  notStarted = false,
): UpdateFailedWarning {
  const details = error instanceof ElwoodError ? error.details : {};
  const base = {
    agent,
    source: "lifecycle",
    code: "agent_update_failed",
    severity: "warning",
    installedVersion,
  } as const;
  const reason = details["updateReason"];
  if (isUpdateSkipReason(reason)) {
    return {
      ...base,
      message: `\`${agent} update\` skipped: ${updateSkipMessages[reason]}; continuing with the installed CLI ${installedVersion}.`,
      errorCode: "update_active",
      raw: "",
    };
  }
  if (isUnconfirmedPeerUpdate(error)) {
    return {
      ...base,
      message: `\`${agent} update\` skipped: another updater's outcome could not be confirmed; continuing with the installed CLI ${installedVersion}.`,
      errorCode: "update_unconfirmed",
      raw: "",
    };
  }
  const refusal = probeRefusalContext(error);
  if (notStarted) {
    return {
      ...base,
      message:
        refusal === undefined
          ? `\`${agent} update\` was not started; continuing with the installed CLI ${installedVersion}.`
          : `\`${agent} update\` was not started. ${refusal} Continuing with the installed CLI ${installedVersion}.`,
      errorCode: "update_not_started",
      raw: "",
    };
  }
  const errno = typeof details["errno"] === "string" ? details["errno"] : undefined;
  const stderr = typeof details["stderr"] === "string" ? details["stderr"] : "";
  const exitStatus = typeof details["exitStatus"] === "number" ? details["exitStatus"] : undefined;
  return {
    ...base,
    message:
      refusal === undefined
        ? `\`${agent} update\` failed; continuing with the installed CLI ${installedVersion}.`
        : `${refusal} Continuing with the installed CLI ${installedVersion}.`,
    errorCode: failureCode(details, errno),
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
