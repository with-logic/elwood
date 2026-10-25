/**
 * A ready read-only Codex session for the real-Codex e2e tests, and its teardown, shared by
 * the model-picker, configured-default, config-lock, and resume tests. Supports PRD §12 and
 * C-E2E-03.
 */

import { type CodexSessionApi, startCodex } from "../../src/index.ts";
import type { CodexSandbox, E2eProject } from "./helpers.ts";
import { keepScratch } from "./scratch.ts";

// Codex fires SessionStart within seconds of launch; a minute without it is a failure.
const defaultReadyTimeoutMs = 60_000;

export type StartReadyCodexOptions = {
  /** The readiness deadline; the wait rejects sooner if the session ends first. */
  readonly readyTimeoutMs?: number;
  /** Receives the session as soon as it starts, so the caller can always tear it down. */
  readonly onStarted?: (session: CodexSessionApi) => void;
};

/** Tears a session down, falling back to kill; returns what failed rather than hiding it. */
export async function teardownOrKillCodex(session: CodexSessionApi): Promise<readonly unknown[]> {
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
  { readyTimeoutMs = defaultReadyTimeoutMs, onStarted }: StartReadyCodexOptions = {},
): Promise<CodexSessionApi> {
  const session = await startCodex({
    cwd: project.cwd,
    stateDir: project.stateDir,
    sandbox: "read-only",
    approvalPolicy: "never",
    autotrust: true,
    hooks: {},
  });
  onStarted?.(session);
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

export type CodexTestEnd = {
  /** Every session the test still holds, torn down here. */
  readonly sessions: readonly (CodexSessionApi | undefined)[];
  readonly project: E2eProject;
  readonly sandbox: CodexSandbox;
  /** A start or resume rejected, so a Codex process may be running with no handle to it. */
  readonly launchRejected: boolean;
  /** What failed the test before cleanup, if anything. */
  readonly failure: unknown;
};

/**
 * Ends a real-Codex test: tears its sessions down, then removes the sandbox only once every
 * Codex process that could use it is confirmed gone. Otherwise the project and sandbox stay
 * past the file's sweep, and this throws with their paths. Cleanup failures, including a
 * failed removal, are thrown alongside the test's own failure rather than in place of it.
 */
export async function endCodexTest(end: CodexTestEnd): Promise<void> {
  const cleanupFailures: unknown[] = [];
  for (const session of end.sessions) {
    if (session) cleanupFailures.push(...(await teardownOrKillCodex(session)));
  }
  const confirmed = cleanupFailures.length === 0 && !end.launchRejected;
  if (confirmed) {
    try {
      end.sandbox.dispose();
    } catch (error) {
      cleanupFailures.push(error);
    }
  } else keepScratch(end.project.cwd, end.sandbox.home);
  if (confirmed && cleanupFailures.length === 0) return;
  const kept = confirmed
    ? ""
    : `; kept ${end.project.cwd} and ${end.sandbox.home}, which a Codex process may still use`;
  const failures = end.failure === undefined ? cleanupFailures : [end.failure, ...cleanupFailures];
  throw new AggregateError(failures, `Codex test cleanup failed${kept}`);
}
