/**
 * A ready read-only Codex session for the real-Codex e2e tests, and its teardown, plus the
 * launch tracking and end-of-test cleanup that every Codex e2e test ends through, so a
 * sandbox a Codex process may still use is kept. Supports PRD §12 and C-E2E-03.
 */

import { type CodexSessionApi, startCodex } from "../../src/index.ts";
import type { CodexSandbox, E2eProject } from "./helpers.ts";
import { keepScratch } from "./scratch.ts";

// Codex fires SessionStart within seconds of launch; a minute without it is a failure.
const defaultReadyTimeoutMs = 60_000;

export type StartReadyCodexOptions = {
  /** The readiness deadline; the wait rejects sooner if the session ends first. */
  readonly readyTimeoutMs?: number;
  /** Records a start that rejected, which leaves no session to tear down. */
  readonly launches: CodexLaunches;
  /**
   * Receives the session as soon as it starts, so the caller can always tear it down: a
   * session that never got ready is torn down here, but its cleanup can fail.
   */
  readonly onStarted: (session: CodexSessionApi) => void;
};

/** What cleanup needs from a session: tests may pass a double. */
export type CodexTestSession = Pick<CodexSessionApi, "teardown" | "kill">;

/** Tears a session down, falling back to kill; returns what failed rather than hiding it. */
export async function teardownOrKillCodex(session: CodexTestSession): Promise<readonly unknown[]> {
  try {
    await session.teardown();
    return [];
  } catch (teardownError) {
    try {
      await session.kill();
      return [];
    } catch (killError) {
      return [teardownError, killError];
    }
  }
}

/**
 * Starts a read-only Codex session in `project` and waits for it to become ready. A session
 * that does not is torn down here first, so the error carries the CLI's final screen: Codex
 * prints its startup error last, and teardown drains output that arrives after the exit
 * (PRD §9.4) before disposing the terminal.
 */
export async function startReadyCodex(
  project: E2eProject,
  { readyTimeoutMs = defaultReadyTimeoutMs, launches, onStarted }: StartReadyCodexOptions,
): Promise<CodexSessionApi> {
  const session = await launches.track(
    startCodex({
      cwd: project.cwd,
      stateDir: project.stateDir,
      sandbox: "read-only",
      approvalPolicy: "never",
      autotrust: true,
      hooks: {},
    }),
  );
  onStarted(session);
  // `terminal:data` fires once each chunk has rendered, so this copy is always the latest
  // screen, taken while the terminal is still live.
  let screen = "";
  const offScreen = session.on("terminal:data", () => {
    screen = session.terminal.snapshot().text.trim();
  });
  try {
    // Rejects as soon as the session reaches a terminal status such as `exited`, rather
    // than waiting out the deadline for a `ready` that cannot come.
    await session.waitForStatus((status) => status === "ready", readyTimeoutMs);
    return session;
  } catch (error) {
    const status = session.status;
    const cleanupFailures = await teardownOrKillCodex(session);
    const cleanupNote = cleanupFailures.length
      ? `\ncleanup also failed: ${cleanupFailures.map(String).join("; ")}`
      : "";
    throw new Error(`codex did not become ready (status ${status}):\n${screen}${cleanupNote}`, {
      cause: error,
    });
  } finally {
    offScreen();
  }
}

/**
 * Records whether a Codex start or resume rejected. A rejected launch may leave a Codex
 * process running that the test holds no handle to, so its scratch must stay.
 */
export type CodexLaunches = {
  /** A launch passed to `track` rejected. */
  readonly rejected: boolean;
  /** Settles as `launch` does, recording a rejection. Route every start and resume here. */
  track<T>(launch: Promise<T>): Promise<T>;
};

export function codexLaunches(): CodexLaunches {
  let rejected = false;
  return {
    get rejected() {
      return rejected;
    },
    track: (launch) =>
      launch.catch((error: unknown) => {
        rejected = true;
        throw error;
      }),
  };
}

export type CodexTestEnd = {
  /** Every session the test still holds, torn down here. */
  readonly sessions: readonly (CodexTestSession | undefined)[];
  /** Every project a Codex process ran in: kept with the sandbox. */
  readonly projects: readonly E2eProject[];
  readonly sandbox: CodexSandbox;
  /** The test's launches: one that rejected keeps the scratch. */
  readonly launches: Pick<CodexLaunches, "rejected">;
  /** What failed the test before cleanup, if anything. */
  readonly failure: unknown;
};

/**
 * Ends a real-Codex test: tears its sessions down, then removes the sandbox only once every
 * Codex process that could use it is confirmed gone. Otherwise the projects and sandbox stay
 * past the file's sweep, `CODEX_HOME` is restored so later tests in the file do not use the
 * kept sandbox, and this throws with their paths. Cleanup failures, including a failed
 * removal, are thrown alongside the test's own failure rather than in place of it.
 */
export async function endCodexTest(end: CodexTestEnd): Promise<void> {
  const cleanupFailures: unknown[] = [];
  for (const session of end.sessions) {
    if (session) cleanupFailures.push(...(await teardownOrKillCodex(session)));
  }
  const confirmed = cleanupFailures.length === 0 && !end.launches.rejected;
  if (confirmed) {
    try {
      end.sandbox.dispose();
    } catch (error) {
      cleanupFailures.push(error);
    }
  }
  const roots = [...end.projects.map((project) => project.cwd), end.sandbox.home];
  if (!confirmed) {
    end.sandbox.restoreHome();
    keepScratch(...roots);
  }
  if (confirmed && cleanupFailures.length === 0) return;
  const kept = confirmed ? "" : `; kept ${roots.join(", ")}, which a Codex process may still use`;
  const failures = end.failure === undefined ? cleanupFailures : [end.failure, ...cleanupFailures];
  throw new AggregateError(failures, `Codex test cleanup failed${kept}`);
}

/** A Codex test's scratch and launches, with the sessions it holds read once its body ends. */
export type CodexTestScope = Omit<CodexTestEnd, "sessions" | "failure"> & {
  readonly sessions: () => CodexTestEnd["sessions"];
};

/**
 * Runs a real-Codex test's body, then ends the test through `endCodexTest` with whatever the
 * body threw, so a cleanup failure is reported alongside the test's own failure.
 */
export async function runCodexTest(
  scope: CodexTestScope,
  body: () => Promise<void>,
): Promise<void> {
  let failure: unknown;
  try {
    await body();
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    await endCodexTest({ ...scope, sessions: scope.sessions(), failure });
  }
}
