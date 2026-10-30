/**
 * Codex PTY spawning with login-shell semantics, and the config path of the `CODEX_HOME`
 * that launch runs with. Implements PRD §4.1, §4.2, §5.3, §5.5, §8.1, and C-CODEX-24.
 */

import { rmSync } from "node:fs";
import { basename, join } from "node:path";
import { runContained } from "../core/contained.ts";
import { defaultTerminalSize } from "../core/defaults.ts";
import { causeDetails, ElwoodError, elwoodError } from "../core/errors.ts";
import type { PtyProcess } from "../pty/types.ts";
import { currentPtyFactory } from "../runtime/seams.ts";
import {
  assertLaunchDirectoryUnchanged,
  type CheckedLaunchDirectory,
} from "../runtime/session/launch-directory.ts";
import { loginShellCommand, userShell } from "../runtime/shell.ts";
import type { SessionRuntime } from "../state/runtime-paths.ts";
import type { SessionRecord } from "../state/store.ts";
import { buildCodexShellCommand } from "./command.ts";
import {
  codexHomeReported,
  reportCodexHomeCommand,
  reportedCodexConfigPath,
  reportFailedStatus,
} from "./config/home.ts";
import * as preflight from "./preflight.ts";
import type { StartCodexOptions } from "./session/types.ts";

/** A launch's options, with the directory it checked first: its PTY is spawned only there. */
export type CodexLaunchOptions = StartCodexOptions & {
  readonly launchDirectory: CheckedLaunchDirectory;
};

export type CodexLaunch = {
  readonly pty: PtyProcess;
  /**
   * The config.toml of the `CODEX_HOME` the launched Codex runs with, from the launch shell's
   * report: waited for until `signal` aborts, then kept (C-CODEX-24).
   */
  readonly resolveConfigPath: (signal: AbortSignal) => Promise<string>;
};

/**
 * Where a launch's `CODEX_HOME` report goes: the session's private runtime home, not its state
 * directory, named after the launch's own socket file. Each launch has its own, which a
 * `noclobber` shell cannot mistake for an earlier one, and a failed start can find it (§8.1).
 */
export function codexHomeReportPath(
  runtime: Pick<SessionRuntime, "socketHome" | "socketPath">,
): string {
  return join(runtime.socketHome, `codex-home-${basename(runtime.socketPath, ".sock")}`);
}

export async function spawnCodexPty(
  record: SessionRecord,
  runtime: Pick<SessionRuntime, "socketHome" | "socketPath" | "bridgeScriptPath">,
  options: CodexLaunchOptions,
): Promise<CodexLaunch> {
  const capabilities = await preflight.detectCodexCliCapabilities(
    options.launchDirectory.cwd,
    options.launchDirectory.identity,
  );
  const reportPath = codexHomeReportPath(runtime);
  const launch = buildCodexShellCommand(
    { ...record, cwd: options.launchDirectory.cwd },
    runtime.bridgeScriptPath,
    options,
    capabilities,
  );
  // After the capability probe, the launch's last await: the agent runs in the directory checked.
  assertLaunchDirectoryUnchanged(options.launchDirectory);
  let pty: PtyProcess;
  try {
    pty = currentPtyFactory()({
      command: userShell(),
      args: loginShellCommand(`${reportCodexHomeCommand(reportPath)}; ${launch}`),
      cwd: options.launchDirectory.cwd,
      directoryIdentity: options.launchDirectory.identity,
      env: { ...process.env, ELWOOD_SESSION_ID: record.elwoodSessionId },
      size: options.initialSize ?? defaultTerminalSize,
    });
  } catch (error) {
    throw elwoodError("pty_start_failed", "Could not start Codex PTY.", causeDetails(error));
  }
  // The report lasts as long as its launch, whether that ends in a failed start or later.
  // Whether the report step failed is decided before it goes, for the start's failure to
  // say so, and a report that cannot be removed never stops the PTY's other exit handlers:
  // the socket home's own removal takes it.
  pty.onExit((exit) => {
    if (exit.exitCode === reportFailedStatus && !codexHomeReported(reportPath))
      failedReportSteps.add(reportPath);
    runContained(() => rmSync(reportPath, { force: true }));
  });
  let resolvedConfigPath: string | undefined;
  return {
    pty,
    resolveConfigPath: async (signal) =>
      (resolvedConfigPath ??= await reportedCodexConfigPath(reportPath, signal)),
  };
}

/** Reports whose launch shell exited at the report step, so Codex never started. */
const failedReportSteps = new Set<string>();

/**
 * A start that failed because the launch shell could not write its `CODEX_HOME` report says
 * so, with the report's path (§8.1, C-CODEX-24). Codex never started then, so the exit status
 * is the report step's: one after a finished report is Codex's own. The shell's own message is
 * never read.
 */
export function explainCodexStartFailure(error: unknown, reportPath: string): unknown {
  const reportFailed =
    error instanceof ElwoodError &&
    error.code === "codex_start_failed" &&
    error.details["exitCode"] === reportFailedStatus &&
    failedReportSteps.delete(reportPath);
  if (!reportFailed) return error;
  return elwoodError(
    "codex_start_failed",
    "Codex did not start: its launch could not write the CODEX_HOME report.",
    { ...error.details, phase: "codex_home_report", path: reportPath },
  );
}
