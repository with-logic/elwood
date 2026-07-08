/**
 * Test seams for process, platform, and PTY dependencies.
 * Implements PRD §13 testability without changing public behavior.
 */

import { spawn } from "node:child_process";
import { nodePtyFactory } from "../pty/node.ts";
import type { PtyFactory } from "../pty/types.ts";

export type CommandResult = {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: { readonly code?: string | undefined; readonly message: string };
};

/**
 * Runs a subprocess and returns its result. Production is async (`spawn`) so a
 * roster of concurrent spawns never serializes on the host event loop; test
 * fakes may stay synchronous — callers always `await` the result.
 */
export type CommandRunner = (
  command: string,
  args: readonly string[],
) => CommandResult | Promise<CommandResult>;

let ptyFactory: PtyFactory | null = null;
let commandRunner: CommandRunner = realCommandRunner;
let platform: string = process.platform;

export function currentPtyFactory(): PtyFactory {
  return ptyFactory ?? nodePtyFactory;
}

export function currentCommandRunner(): CommandRunner {
  return commandRunner;
}

export function currentPlatform(): string {
  return platform;
}

export function setPtyFactoryForTests(factory: PtyFactory): void {
  ptyFactory = factory;
}

export function setCommandRunnerForTests(runner: CommandRunner): void {
  commandRunner = runner;
}

export function setPlatformForTests(value: string): void {
  platform = value;
}

export function resetRuntimeSeamsForTests(): void {
  ptyFactory = null;
  commandRunner = realCommandRunner;
  platform = process.platform;
}

function realCommandRunner(command: string, args: readonly string[]): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, [...args]);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    // Spawn failure (e.g. ENOENT) fires `error` and not `close`; resolve the
    // same shape spawnSync produced. A later `close` is a no-op — Promise
    // ignores the second settle. Node's spawn `error` always carries a `code`
    // (e.g. "ENOENT"), which preflight maps to `*_not_found`.
    child.on("error", (err: NodeJS.ErrnoException) => {
      resolve({ status: null, stdout, stderr, error: { code: err.code, message: err.message } });
    });
    child.on("close", (code) => {
      resolve({ status: code, stdout, stderr });
    });
  });
}
