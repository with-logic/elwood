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
  const confirmed = cleanupFailures.length === 0 && !end.launches.anyRejected;
  if (confirmed) {
    try {
      end.sandbox.dispose();
    } catch (error) {
      cleanupFailures.push(error);
    }
  }
  const projects = [end.sandbox.project, ...(end.otherProjects ?? [])];
  const roots = [...projects.map((project) => project.cwd), end.sandbox.home];
  if (!confirmed) {
    end.sandbox.restoreHome();
    keepScratch(...roots);
  }
  if (confirmed && cleanupFailures.length === 0) return;
  const kept = confirmed ? "" : `; kept ${roots.join(", ")}, which a Codex process may still use`;
  const failures = end.failure ? [end.failure.error, ...cleanupFailures] : cleanupFailures;
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
