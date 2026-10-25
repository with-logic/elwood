/**
 * Best-effort startup cleanup that preserves the original startup error.
 * Implements PRD §9.1 and §10 error stability.
 */

export type StartupTerminationTimeouts = {
  readonly gracefulMs: number;
  readonly forceMs: number;
};

/** A failed startup's PTY, ended by the session that owns its exit and its reaper. */
export type StartupPty = {
  /** The leader's pid, which is also its process-group id. */
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

export async function cleanupStartupResources(resources: StartupCleanupResources): Promise<void> {
  tryCall(resources.before);
  // The session ends its PTY with the reaper its exit path uses, so the leader's group
  // is SIGKILLed once (PRD §9.1, §9.4, C-LIFE-10). That kill is attempted even when the
  // PTY signal throws, so a hook-bridge grandchild reparented to PID 1 is not left
  // behind. A termination/reap failure stays SECONDARY: it is contained here so the
  // original startup error is the one that rejects.
  if (resources.pty)
    await endPty(resources.pty, resources.terminationTimeouts ?? startupTermination);
  await stopQuietly(resources.bridge);
  tryCall(resources.after);
  tryCall(resources.terminal?.dispose.bind(resources.terminal));
}

async function endPty(pty: StartupPty, timeouts: StartupTerminationTimeouts): Promise<void> {
  try {
    await pty.terminate(timeouts);
  } catch {
    // Preserve the original startup error; a reap/termination failure is secondary.
  }
}

/**
 * Runs the post-session-construction startup steps behind ONE cleanup boundary
 * (PRD §9.1, §9.4): if `region` rejects — a failed startup assertion, a PTY write
 * fault, anything — the now-live PTY, bridge, terminal, and any watcher
 * are torn down via `cleanupStartupResources` before the original error rethrows, so
 * a rejected `startClaude`/`startCodex` never leaks live resources.
 */
export async function guardStartupRegion(
  region: () => Promise<void>,
  resources: StartupCleanupResources,
): Promise<void> {
  try {
    await region();
  } catch (error) {
    await cleanupStartupResources(resources);
    throw error;
  }
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
