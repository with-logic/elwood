/**
 * Foreground agent spawning for `elwood interactive`: inherited stdio, no PTY, no
 * observation, the agent's own exit status.
 * Implements PRD §12A.9 and C-CLI-25.
 */

import { spawn } from "node:child_process";
import { causeDetails, elwoodError, errnoCode } from "../../core/errors.ts";
import { exitStatus } from "../../runtime/exit-status.ts";
import { type CommandResult, currentCommandRunner } from "../../runtime/seams.ts";
import { probeShellCommand, userShell } from "../../runtime/shell.ts";
import type { CliAgent } from "../types.ts";

export type InteractiveLaunch = {
  readonly agent: CliAgent;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
};

/** Runs the agent in the foreground and resolves with its exit status. */
export type InteractiveSpawner = (launch: InteractiveLaunch) => Promise<number>;

export const spawnInteractiveAgent: InteractiveSpawner = async (launch) => {
  const path = await loginShellPath().catch((error: unknown) => {
    throw spawnFailure(launch, error);
  });
  return new Promise((resolve, reject) => {
    const child = spawn(launch.command, launch.args, {
      cwd: launch.cwd,
      env: { ...process.env, PATH: path },
      stdio: "inherit",
    });
    child.once("error", (error) => reject(spawnFailure(launch, error)));
    child.once("exit", (code, signal) => resolve(exitStatus(code, signal)));
  });
};

function spawnFailure(launch: InteractiveLaunch, error: unknown) {
  const missing = errnoCode(error) === "ENOENT";
  const code = `${launch.agent}_${missing ? "not_found" : "start_failed"}` as const;
  return elwoodError(
    code,
    missing
      ? `The ${launch.command} command is not available on PATH.`
      : `Could not start ${launch.command} in the foreground.`,
    causeDetails(error),
  );
}

/**
 * Match detection PATH without inserting a shell between terminal signals and the agent. The
 * lookup is a probe like detection's, so the user's profile gets the login shell's own bound
 * and the `printf` the command's (§9.2, C-PERF-05).
 */
async function loginShellPath(): Promise<string | undefined> {
  // The login shell expands its own `$PATH` into the argument, and `/bin/sh`, which loads no
  // startup file, prints it with its builtin `printf`. A `printf` function or alias in the
  // user's startup files therefore cannot print something else, and an empty PATH still
  // prints. The NUL frame tells an empty PATH from a lookup that printed nothing.
  const command = probeShellCommand(`/bin/sh -c 'printf "\\0%s\\0" "$1"' sh "$PATH"`);
  const result = await currentCommandRunner()(userShell(), command);
  // A shell that exited on its own, successfully, may never have run the lookup (§12A.9).
  const status = result.error === undefined ? result.status : result.error.shellStatus;
  if (status !== 0) throw lookupFailure(result);
  const parts = result.stdout.split("\u0000");
  // Early-exiting shell startup can succeed without running the probe.
  return parts.length >= 3 ? parts.at(-2) : process.env["PATH"];
}

function lookupFailure({ status, error }: CommandResult): Error {
  const message = error?.message ?? `login shell exited with status ${status}`;
  return Object.assign(new Error(message), error?.code === undefined ? {} : { code: error.code });
}
