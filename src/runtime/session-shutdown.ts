/**
 * Explicit shutdown/teardown orchestration for AgentSessionBase, extracted to keep
 * the base within the file-size cap. Implements PRD §5.3/§9.4 (C-LIFE-10): every
 * path ATTEMPTS/RETRIES the leader's process-group reap and propagates a reap failure
 * as a typed error (never swallows it), while an already-terminal session is never
 * re-signaled — node-pty does not replay the exit and the pid may be recycled.
 */

import { elwoodError } from "../core/errors.ts";
import type { PtyProcess } from "../pty/types.ts";
import { removeSessionFiles } from "../state/store.ts";
import type { SessionReapPolicy } from "./session-reap.ts";
import { terminalStatuses } from "./session-status.ts";
import type { ShutdownContext, ShutdownCoordinator } from "./shutdown-coordinator.ts";
import type { StatusEvidenceKind } from "./status-evidence.ts";
import { runTeardownSteps } from "./teardown.ts";
import { terminatePty } from "./terminate.ts";

/** Evidence kinds an explicit shutdown submits once it drives the PTY to exit. */
export type ShutdownEvidence = "stop_completed" | "kill_completed" | "teardown_completed";

/** The session surface the shutdown/teardown orchestration drives. */
export type ShutdownHost = {
  readonly pty: PtyProcess;
  readonly stateDir: string;
  readonly elwoodSessionId: string;
  /** This launch's socket path; teardown removes its whole stable home (§8.1). */
  readonly socketPath: string;
  readonly reapPolicy: SessionReapPolicy;
  readonly status: () => import("../core/types.ts").ElwoodSessionStatus;
  readonly claimShutdown: (evidence: ShutdownEvidence) => void;
  readonly cleanupRuntime: () => Promise<void>;
  readonly submitEvidence: (kind: StatusEvidenceKind) => void;
};

/** The three public shutdown verbs bound to a coordinator and lazy host. */
type ManagedShutdown = {
  readonly stop: () => Promise<void>;
  readonly kill: () => Promise<void>;
  readonly teardown: () => Promise<void>;
};

/** Binds `stop`/`kill`/`teardown` to one coordinator + lazily-built host (C-LIFE-10). */
export function managedShutdown(
  coordinator: ShutdownCoordinator,
  host: () => ShutdownHost,
): ManagedShutdown {
  return {
    stop: () => runManagedShutdown(coordinator, "stop", host),
    kill: () => runManagedShutdown(coordinator, "kill", host),
    teardown: () => runManagedShutdown(coordinator, "teardown", host),
  };
}

/** How each public shutdown verb maps onto the coordinator + orchestration call. */
const shutdownVerbs = {
  stop: (host: ShutdownHost, ctx: ShutdownContext) =>
    runShutdown(host, "SIGTERM", "stop_completed", ctx),
  kill: (host: ShutdownHost, ctx: ShutdownContext) =>
    runShutdown(host, "SIGKILL", "kill_completed", ctx),
  teardown: (host: ShutdownHost, ctx: ShutdownContext) => runTeardown(host, ctx),
} as const;

/**
 * Route a public `stop`/`kill`/`teardown` through the session's coordinator so the
 * PTY is signaled at most once and overlapping callers join the in-flight shutdown
 * (C-LIFE-10). The host is built lazily inside the coordinated operation, which is
 * told whether the PTY was `alreadySignaled` so a retry never re-signals it.
 */
function runManagedShutdown(
  coordinator: ShutdownCoordinator,
  verb: keyof typeof shutdownVerbs,
  host: () => ShutdownHost,
): Promise<void> {
  return coordinator.run(verb, (ctx) => shutdownVerbs[verb](host(), ctx));
}

/**
 * True when the PTY must NOT be signaled: either a prior shutdown already signaled it
 * (a predecessor that signaled+reaped but threw before submitting terminal status must
 * not trigger a re-signal of a possibly-recycled PID) OR the session already reached a
 * terminal status. Signal ownership is tracked INDEPENDENTLY of lifecycle status so a
 * non-terminal-but-already-signaled state still refuses a second signal (C-LIFE-10).
 */
function mustNotSignal(host: ShutdownHost, ctx: ShutdownContext): boolean {
  return ctx.alreadySignaled || terminalStatuses.has(host.status());
}

/**
 * Graceful stop / force kill. Does NOT re-signal when the PTY was already signaled
 * (by a prior shutdown, even one that threw before going terminal) or the session is
 * already terminal — node-pty won't replay exit (the wait would time out) and the pid
 * may be recycled. In that case it performs a one-shot survivor reap that rejects with
 * a typed error on failure and leaves the reap retryable; a first, live shutdown marks
 * signal ownership, terminates the PTY (which reaps on every path), and records
 * shutdown evidence (C-LIFE-10).
 */
export async function runShutdown(
  host: ShutdownHost,
  signal: "SIGTERM" | "SIGKILL",
  evidence: ShutdownEvidence,
  ctx: ShutdownContext,
): Promise<void> {
  host.claimShutdown(evidence); // Claim the exit before signaling.
  if (mustNotSignal(host, ctx)) {
    host.reapPolicy.orThrow(); // Typed rejection on failure; never swallows.
    await cleanupOrThrowTermination(host);
    return; // Already signaled / terminal: no new signal, no evidence to submit.
  }
  ctx.markSignaled();
  await terminatePty(host.pty, signal, host.reapPolicy.reaper);
  await cleanupOrThrowTermination(host);
  host.submitEvidence(evidence);
}

/**
 * Runs runtime cleanup, folding its raw aggregate failure into the stable public
 * `termination_failed` error. `runCleanupSteps` rejects with a bare `Error` on the
 * assumption that its caller wraps it; `stop()`/`kill()` are that caller, so without
 * this an untyped Error would escape the public shutdown boundary (PRD §10).
 */
async function cleanupOrThrowTermination(host: ShutdownHost): Promise<void> {
  try {
    await host.cleanupRuntime();
  } catch (error) {
    throw elwoodError("termination_failed", "Could not clean up the Elwood runtime.", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Teardown: terminate a still-live PTY (unless it was already signaled), reap
 * (retrying a prior failed reap), stop the runtime, record teardown evidence, and
 * remove owned session files. Each step runs even if an earlier one rejected, so a
 * leaked group is always reaped; a re-signal is refused once signal ownership is held.
 */
export async function runTeardown(host: ShutdownHost, ctx: ShutdownContext): Promise<void> {
  host.claimShutdown("teardown_completed");
  const shouldSignal = () => !mustNotSignal(host, ctx);
  await runTeardownSteps([
    () => {
      if (!shouldSignal()) return undefined;
      ctx.markSignaled();
      return terminatePty(host.pty, "SIGKILL", host.reapPolicy.reaper);
    },
    () => host.reapPolicy.reaper.reap(), // No-op once latched; retries a failed reap.
    () => host.cleanupRuntime(),
    () => host.submitEvidence("teardown_completed"),
    () =>
      removeSessionFiles({
        stateDir: host.stateDir,
        elwoodSessionId: host.elwoodSessionId,
        socketPath: host.socketPath,
      }),
  ]);
}
