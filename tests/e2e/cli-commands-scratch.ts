/**
 * Scratch for the compiled-CLI command e2e (PRD §12A.7-§12A.10, C-CLI-23 through C-CLI-26).
 * For Codex, every run that can start Codex is tracked and counts only once it confirms its
 * own cleanup, and the test ends through `runCodexTest`: its project and sandbox stay unless
 * every Codex it started is confirmed gone (PRD §12).
 */
import { rmSync } from "node:fs";
import { type Invocation, invoke } from "./cli-commands-helpers.ts";
import { codexLaunches, runCodexTest } from "./codex-test-end.ts";
import type { CodexSandbox, E2eProject } from "./helpers.ts";

/**
 * Passes a CLI run only once it has confirmed its own cleanup: status 0 does, since a
 * cleanup failure fails an otherwise successful run (PRD §12A). Otherwise the agent it
 * launched may still be running, so this throws, and a tracked launch keeps the scratch.
 */
export function cleanedUp(result: Invocation): Invocation {
  if (result.status === 0) return result;
  const streams = `stdout: ${result.stdout}\nstderr: ${result.stderr}`;
  throw new Error(`the CLI exited ${result.status} without confirming its cleanup\n${streams}`);
}

export type CliScratch = {
  /** `elwood <args>` in `cwd`; for Codex, tracked, and rejected unless it exits 0. */
  run(args: readonly string[], cwd: string): Promise<Invocation>;
  /** For Codex, records a launch that rejects, which keeps the scratch. */
  track<T>(launch: Promise<T>): Promise<T>;
  /** Runs the test's body, then removes its scratch: for Codex, only once confirmed. */
  end(body: () => Promise<void>): Promise<void>;
};

/** `sandbox` is the Codex test's own `CODEX_HOME`; a Claude test has none. */
export function cliScratch(project: E2eProject, sandbox: CodexSandbox | undefined): CliScratch {
  const launches = codexLaunches();
  const track = <T>(launch: Promise<T>) => (sandbox ? launches.track(launch) : launch);
  return {
    run: (args, cwd) => {
      const ran = invoke(args, cwd);
      return sandbox ? launches.track(ran.then(cleanedUp)) : ran;
    },
    track,
    end: (body) =>
      sandbox
        ? runCodexTest({ sessions: () => [], sandbox, launches }, body)
        : body().finally(() => rmSync(project.cwd, { recursive: true, force: true })),
  };
}
