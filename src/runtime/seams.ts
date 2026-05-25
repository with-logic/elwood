/**
 * Test seams for process, platform, and PTY dependencies.
 * Implements PRD §13 testability without changing public behavior.
 */

import { spawnSync } from "node:child_process";
import { nodePtyFactory } from "../pty/node.ts";
import type { PtyFactory } from "../pty/types.ts";

export type CommandResult = {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: { readonly code?: string; readonly message: string };
};

export type CommandRunner = (command: string, args: readonly string[]) => CommandResult;

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

function realCommandRunner(command: string, args: readonly string[]): CommandResult {
  const result = spawnSync(command, [...args], { encoding: "utf8" });
  const error = result.error as { readonly code?: string; readonly message: string } | undefined;
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    ...(error === undefined ? {} : { error }),
  };
}
