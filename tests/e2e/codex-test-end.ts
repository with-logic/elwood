/**
 * How every real-Codex e2e test ends: launch tracking and cleanup that remove a test's
 * scratch only once every Codex process that could use it is confirmed gone, and keep it,
 * with `CODEX_HOME` restored, otherwise. Supports PRD §12 and C-E2E-03.
 */

import type { TestContext } from "node:test";
import type { CodexSessionApi } from "../../src/index.ts";
import type { CodexSandbox, E2eProject } from "./helpers.ts";
import { keepScratch } from "./scratch.ts";

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
 * Records whether any Codex launch rejected. A rejected launch may leave a Codex process
 * running that the test holds no handle to, so its scratch must stay.
 */
export type CodexLaunches = {
  /** Sticky: some launch passed to `track` rejected. */
  readonly anyRejected: boolean;
  /**
   * Settles as `launch` does, recording a rejection. Route here every start, resume, model
   * probe, and `elwood` CLI invocation: each can leave a Codex process running.
   */
  track<T>(launch: Promise<T>): Promise<T>;
};

export function codexLaunches(): CodexLaunches {
  let anyRejected = false;
  return {
    get anyRejected() {
      return anyRejected;
    },
    track: (launch) =>
      launch.catch((error: unknown) => {
        anyRejected = true;
        throw error;
      }),
  };
}

export type CodexTestEnd = {
  /** Every session the test still holds, torn down here. */
  readonly sessions: readonly (CodexTestSession | undefined)[];
  /** Projects besides the sandbox's own that a Codex process ran in: kept with it. */
  readonly otherProjects?: readonly E2eProject[];
  readonly sandbox: CodexSandbox;
  /** The test's launches: one that rejected keeps the scratch. */
  readonly launches: Pick<CodexLaunches, "anyRejected">;
  /** What failed the test before cleanup; `undefined` when nothing did. */
  readonly failure: { readonly error: unknown } | undefined;
};

/**
 * Ends a real-Codex test: tears its sessions down and, once every session is confirmed gone
 * and no launch rejected, calls `sandbox.dispose()`, which stops any process still running
 * from the home, such as Codex's app-server daemon, and removes it. When teardown, a launch,
 * or that disposal fails, the projects and sandbox stay past the file's sweep, `CODEX_HOME` is
 * restored so later tests in the file do not use the kept sandbox, and this throws with their
 * paths. Cleanup failures are thrown alongside the test's own failure rather than in place of
 * it.
 */
export async function endCodexTest(end: CodexTestEnd): Promise<void> {
  const cleanupFailures: unknown[] = [];
  for (const session of end.sessions) {
    if (session) cleanupFailures.push(...(await teardownOrKillCodex(session)));
  }
  let confirmed = cleanupFailures.length === 0 && !end.launches.anyRejected;
  if (confirmed) {
    try {
      end.sandbox.dispose();
    } catch (error) {
      // Something still running from the sandbox, such as Codex's app-server daemon, would
      // not stop, or the removal failed partway: what is left stays, for diagnosis.
      cleanupFailures.push(error);
      confirmed = false;
    }
  }
  if (confirmed) return;
  const projects = [end.sandbox.project, ...(end.otherProjects ?? [])];
  const roots = [...projects.map((project) => project.cwd), end.sandbox.home];
  end.sandbox.restoreHome();
  keepScratch(...roots);
  const kept = `kept ${roots.join(", ")}, which a Codex process may still use`;
  const failures = end.failure ? [end.failure.error, ...cleanupFailures] : cleanupFailures;
  throw new AggregateError(failures, `Codex test cleanup failed; ${kept}`);
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
  let failure: CodexTestEnd["failure"];
  try {
    await body();
  } catch (error) {
    failure = { error };
    throw error;
  } finally {
    await endCodexTest({ ...scope, sessions: scope.sessions(), failure });
  }
}

/**
 * `endCodexTest` for a `t.after` hook. `node:test` drops an after hook's error once the test
 * itself has failed, so a cleanup failure, with any kept paths, is also written as a test
 * diagnostic, which it keeps.
 */
export async function endCodexTestAfter(
  t: Pick<TestContext, "diagnostic">,
  end: Omit<CodexTestEnd, "failure">,
): Promise<void> {
  try {
    await endCodexTest({ ...end, failure: undefined });
  } catch (error) {
    const causes = error instanceof AggregateError ? error.errors : [];
    t.diagnostic([error, ...causes].map(String).join("; "));
    throw error;
  }
}
