/**
 * Foreground agent spawning for `elwood interactive`: inherited stdio, no PTY, no
 * observation, the agent's own exit status.
 * Implements PRD §12A.9 and C-CLI-25.
 */

import { execFile, spawn } from "node:child_process";
import { constants } from "node:os";
import { causeDetails, elwoodError, errnoCode } from "../../core/errors.ts";
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

/** A signal-terminated agent maps to the shell convention 128 + signal number. */
export function exitStatus(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) return code;
  const number = signal === null ? undefined : constants.signals[signal];
  return number === undefined ? 1 : 128 + number;
}

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

/** Match detection PATH without inserting a shell between terminal signals and the agent. */
function loginShellPath(): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    // NUL framing separates the exported PATH from incidental shell-startup stdout.
    execFile(
      userShell(),
      probeShellCommand("printf '\\0%s\\0' \"$PATH\""),
      { timeout: 10_000 },
      (error, stdout) => {
        if (error) reject(error);
        else {
          const parts = stdout.split("\u0000");
          // Early-exiting shell startup can succeed without running the probe.
          resolve(parts.length >= 3 ? parts.at(-2) : process.env["PATH"]);
        }
      },
    );
  });
}
