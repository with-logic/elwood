/**
 * Best-effort startup cleanup that preserves the original startup error.
 * Implements PRD §9.1 and §10 error stability.
 */

import { ElwoodError, elwoodError, underlyingErrno } from "../../core/errors.ts";
import {
  isReapErrorCode,
  type ReapErrorCode,
  unknownErrorToken,
} from "../../core/warnings/reasons.ts";

export type StartupTerminationTimeouts = {
  readonly gracefulMs: number;
  readonly forceMs: number;
};

/** A failed startup's PTY, ended by the session that owns its exit and its reaper. */
export type StartupPty = {
  /** The leader's pid, which is also its process-group id; reported, never signaled. */
  readonly pid: number;
  /** Ends the PTY and reaps its group; never signals a PTY whose exit was already seen. */
  readonly terminate: (timeouts: StartupTerminationTimeouts) => Promise<void>;
};

export type StartupCleanupResources = {
  readonly before?: () => void;
  readonly bridge?: { readonly stop: () => Promise<void> };
  readonly pty?: StartupPty;
  readonly terminal?: { readonly dispose: () => void };
  readonly after?: () => void;
  /** Overrides the bounded PTY termination window (tests only; production defaults). */
  readonly terminationTimeouts?: StartupTerminationTimeouts;
};

/** The parts of a failed startup's cleanup that the session itself owns. */
export type SessionStartupCleanup = Required<Pick<StartupCleanupResources, "before" | "pty">>;

/**
 * A failed startup's PTY termination or group reap that could not be confirmed (§9.1),
 * so part of the CLI's process tree may still be running. The errno token is
 * allowlisted, so it is content-free. The group id is diagnostic only: once the leader is
 * gone the number may be reissued to an unrelated group, so it is never signaled. This
 * covers the PTY only; the other cleanup steps stay best-effort and unreported.
 */
export type UnconfirmedStartupPtyCleanup = {
  readonly cleanupErrorCode: ReapErrorCode;
  readonly cleanupProcessGroupId: number;
};

/**
 * Wraps the ENTIRE `start*FromRecord` body so the fresh per-launch socket FILE the
 * launch minted is removed on ANY failure before the session takes ownership — a
 * failed state/runtime write, bridge start, PTY start, or guarded post-spawn step
 * otherwise leaks a socket under `/tmp/elwood-*` (§9.1). It removes only THIS launch's
 * own file, never the shared stable home a concurrent launch may still own; the home is
 * deterministic, so the session's next start/resume/teardown collects any empty
 * leftover. On success ownership transfers to the returned session (teardown removes the
 * whole home). The cleanup is contained so it never replaces the original startup error.
 */
export async function withSocketHomeCleanup<T>(
  removeOwnSocketFile: () => void,
  build: () => Promise<T>,
): Promise<T> {
  try {
    return await build();
  } catch (error) {
    try {
      removeOwnSocketFile();
    } catch {
      // Secondary: the original startup error is the one that rejects.
    }
    throw error;
  }
}

// Bounded so a failed startup never hangs on an unresponsive CLI while still
// giving the leader a chance to exit gracefully before the group SIGKILL reap.
const startupTermination: StartupTerminationTimeouts = { gracefulMs: 5_000, forceMs: 1_000 };

/**
 * Runs every cleanup step, each best-effort. Resolves to the unconfirmed PTY cleanup, or
 * `undefined` when there was no PTY or its termination and group reap were both
 * confirmed. Failures of the other steps never surface here.
 */
export async function cleanupStartupResources(
  resources: StartupCleanupResources,
): Promise<UnconfirmedStartupPtyCleanup | undefined> {
  tryCall(resources.before);
  // The session ends its PTY with the reaper its exit path uses, so the leader's group
  // is SIGKILLed once (PRD §9.1, §9.4, C-LIFE-10). That kill is attempted even when the
  // PTY signal throws, so a hook-bridge grandchild reparented to PID 1 is not left
  // behind. A failure stays secondary: it is returned as a content-free diagnostic,
  // never thrown in place of the startup error, and the group may still be running.
  const unconfirmed = resources.pty
    ? await endPty(resources.pty, resources.terminationTimeouts ?? startupTermination)
    : undefined;
  await stopQuietly(resources.bridge);
  tryCall(resources.after);
  tryCall(resources.terminal?.dispose.bind(resources.terminal));
  return unconfirmed;
}

async function endPty(
  pty: StartupPty,
  timeouts: StartupTerminationTimeouts,
): Promise<UnconfirmedStartupPtyCleanup | undefined> {
  try {
    await pty.terminate(timeouts);
    return undefined;
  } catch (error) {
    const errno = cleanupErrno(error);
    return {
      cleanupErrorCode: isReapErrorCode(errno) ? errno : unknownErrorToken,
      cleanupProcessGroupId: pty.pid,
    };
  }
}

/**
 * The errno to report: the failed group reap's errno when there is one, because that
 * reap decides whether descendants may still be running; otherwise the termination's.
 */
function cleanupErrno(error: unknown): string | undefined {
  const reapErrno = error instanceof ElwoodError ? error.details["reapErrno"] : undefined;
  return typeof reapErrno === "string" ? reapErrno : underlyingErrno(error);
}

/**
 * Runs the post-session-construction startup steps behind ONE cleanup boundary
 * (PRD §9.1, §9.4): if `region` rejects — a failed startup assertion, a PTY write
 * fault, anything — the now-live PTY, bridge, terminal, and any watcher are torn down
 * via `cleanupStartupResources` before the original error rethrows. That teardown is
 * best-effort: when the PTY's termination or group reap could not be confirmed, part of
 * the process tree may remain, and a typed startup error names that in its details.
 */
export async function guardStartupRegion(
  region: () => Promise<void>,
  resources: StartupCleanupResources,
): Promise<void> {
  try {
    await region();
  } catch (error) {
    throw withCleanupFailure(error, await cleanupStartupResources(resources));
  }
}

/**
 * Keeps the startup error's code, message, and stack and adds the unconfirmed-cleanup
 * details. Only Elwood's own typed errors gain them: any other startup error is
 * rethrown unchanged, never wrapped or mutated.
 */
function withCleanupFailure(
  error: unknown,
  unconfirmed: UnconfirmedStartupPtyCleanup | undefined,
): unknown {
  if (unconfirmed === undefined || !(error instanceof ElwoodError)) return error;
  const enriched = elwoodError(error.code, error.message, { ...error.details, ...unconfirmed });
  return Object.assign(enriched, { stack: error.stack });
}

/** Stops the bridge if one exists; a sync throw or rejection stays secondary. */
async function stopQuietly(bridge: StartupCleanupResources["bridge"]): Promise<void> {
  try {
    await bridge?.stop();
  } catch {
    // Preserve the original startup error.
  }
}

function tryCall(callback: (() => void) | undefined): void {
  try {
    callback?.();
  } catch {
    // Preserve the original startup error.
  }
}
