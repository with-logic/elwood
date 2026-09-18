/**
 * Test seams for process, platform, and PTY dependencies.
 * Implements PRD §13 testability without changing public behavior.
 */

import { nodePtyFactory } from "../pty/node.ts";
import type { PtyFactory } from "../pty/types.ts";
import { resetProbeTimeoutForTests, runProbe } from "./probe.ts";
import type { ProbeCleanup } from "./probe-cleanup.ts";

export type CommandResult = {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: { readonly code?: string | undefined; readonly message: string } & ProbeCleanup;
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
let commandRunner: CommandRunner = runProbe;
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
  commandRunner = runProbe;
  platform = process.platform;
  resetProbeTimeoutForTests();
}
