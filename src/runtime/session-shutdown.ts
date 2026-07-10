/**
 * Explicit shutdown/teardown orchestration for AgentSessionBase, extracted to keep
 * the base within the file-size cap. Implements PRD §5.3/§9.4 (C-LIFE-10): every
 * path guarantees the leader's process group is reaped, and an already-terminal
 * session is never re-signaled (Finding C) while its reap failures are still
 * surfaced as typed errors (Finding B) instead of being swallowed.
 */

import type { PtyProcess } from "../pty/types.ts";
import { removeSessionDir, type SessionRecord } from "../state/store.ts";
import type { SessionReapPolicy } from "./session-reap.ts";
import { terminalStatuses } from "./session-status.ts";
import type { StatusEvidenceKind } from "./status-evidence.ts";
import { runTeardownSteps } from "./teardown.ts";
import { terminatePty } from "./terminate.ts";

/** Evidence kinds an explicit shutdown submits once it drives the PTY to exit. */
export type ShutdownEvidence = "stop_completed" | "kill_completed" | "teardown_completed";

/** The session surface the shutdown/teardown orchestration drives. */
export type ShutdownHost = {
  readonly pty: PtyProcess;
  readonly record: SessionRecord;
  readonly reapPolicy: SessionReapPolicy;
  readonly status: () => import("../core/types.ts").ElwoodSessionStatus;
  readonly claimShutdown: (evidence: ShutdownEvidence) => void;
  readonly cleanupRuntime: () => Promise<void>;
  readonly submitEvidence: (kind: StatusEvidenceKind) => void;
};

/**
 * Graceful stop / force kill. Snapshots terminality for EVERY terminal status, not
 * just `exited` (Finding C): a stop/kill racing after a first exit already set
 * stopped/killed must NOT re-signal the dead PTY — node-pty won't replay exit (the
 * wait would time out) and the pid may be recycled. An already-terminal session
 * performs a one-shot survivor reap that rejects with a typed error on failure
 * (Finding B) and leaves the reap retryable for teardown; a live session terminates
 * the PTY (which reaps on every path) and then records shutdown evidence.
 */
export async function runShutdown(
  host: ShutdownHost,
  signal: "SIGTERM" | "SIGKILL",
  evidence: ShutdownEvidence,
): Promise<void> {
  const alreadyTerminal = terminalStatuses.has(host.status());
  host.claimShutdown(evidence); // Claim the exit before signaling.
  if (alreadyTerminal) {
    host.reapPolicy.orThrow(); // Typed rejection on failure; never swallows.
    await host.cleanupRuntime();
    return; // A terminal status cannot transition; no new evidence to submit.
  }
  await terminatePty(host.pty, signal, host.reapPolicy.reaper);
  await host.cleanupRuntime();
  host.submitEvidence(evidence);
}

/**
 * Teardown: terminate a still-live PTY, reap (retrying a prior failed reap), stop
 * the runtime, record teardown evidence, and remove owned session files. Each step
 * runs even if an earlier one rejected, so a leaked group is always reaped.
 */
export async function runTeardown(host: ShutdownHost): Promise<void> {
  host.claimShutdown("teardown_completed");
  const live = () => !terminalStatuses.has(host.status());
  await runTeardownSteps([
    () => (live() ? terminatePty(host.pty, "SIGKILL", host.reapPolicy.reaper) : undefined),
    () => host.reapPolicy.reaper.reap(), // No-op once latched; retries a failed reap.
    () => host.cleanupRuntime(),
    () => host.submitEvidence("teardown_completed"),
    () => removeSessionDir(host.record),
  ]);
}
