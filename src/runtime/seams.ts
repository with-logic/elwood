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
  probeTimeoutMs = defaultProbeTimeoutMs;
}

// A misbehaving CLI on PATH must not stream forever or flood memory during a
// one-shot probe: bound each probe's runtime and captured output.
const defaultProbeTimeoutMs = 15_000;
const maxProbeOutputBytes = 1_000_000;
let probeTimeoutMs = defaultProbeTimeoutMs;

export function setProbeTimeoutMsForTests(value: number): void {
  probeTimeoutMs = value;
}

function realCommandRunner(command: string, args: readonly string[]): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, [...args]);
    let stdout = "";
    let stderr = "";
    let settled = false;
    const settle = (result: CommandResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      resolve(result);
    };
    const capture = (current: string, chunk: string): string =>
      (current + chunk).slice(0, maxProbeOutputBytes);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = capture(stdout, chunk);
      if (stdout.length >= maxProbeOutputBytes) settle(overflow(stdout, stderr));
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = capture(stderr, chunk);
      if (stderr.length >= maxProbeOutputBytes) settle(overflow(stdout, stderr));
    });
    // Spawn failure (e.g. ENOENT) fires `error` and not `close`. Node's spawn
    // `error` always carries a `code`, which preflight maps to `*_not_found`.
    child.on("error", (err: NodeJS.ErrnoException) => {
      settle({ status: null, stdout, stderr, error: { code: err.code, message: err.message } });
    });
    child.on("close", (code) => {
      settle({ status: code, stdout, stderr });
    });
    const timer = setTimeout(() => {
      settle({
        status: null,
        stdout,
        stderr,
        error: { code: "ETIMEDOUT", message: `probe timed out after ${probeTimeoutMs} ms` },
      });
    }, probeTimeoutMs);
    timer.unref?.();
  });
}

function overflow(stdout: string, stderr: string): CommandResult {
  return {
    status: null,
    stdout,
    stderr,
    error: { code: "E2BIG", message: `probe output exceeded ${maxProbeOutputBytes} bytes` },
  };
}
