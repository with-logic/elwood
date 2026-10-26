/**
 * Test seams for process, platform, and PTY dependencies.
 * Implements PRD §13 testability without changing public behavior.
 */

import { nodePtyFactory } from "../pty/node.ts";
import type { PtyFactory } from "../pty/types.ts";
import type { ProbeCleanup } from "./probe/cleanup.ts";
import { resetProbeTimeoutsForTests, runProbe } from "./probe/index.ts";

export type CommandResult = {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: {
    readonly code?: string | undefined;
    readonly message: string;
    /** Set when the user's login shell, not the probe command, failed (§9.2, C-PERF-05). */
    readonly phase?: "login_shell";
    /** The login shell's own status when it exited before starting the command. */
    readonly shellStatus?: number | null;
  } & ProbeCleanup;
};

/** Which directory a path named when it was checked: its device and inode. */
export type DirectoryIdentity = { readonly dev: bigint; readonly ino: bigint };

/**
 * Where a probe runs: `cwd` defaults to Elwood's own working directory. Given the `identity`
 * `cwd` had when the probe's answer was keyed, the probe spawns only while `cwd` is still that
 * directory, and otherwise fails without running (C-PERF-02).
 */
export type CommandOptions =
  | { readonly cwd?: string; readonly identity?: undefined }
  | { readonly cwd: string; readonly identity: DirectoryIdentity };

/**
 * Runs a subprocess and returns its result. Production is async (`spawn`) so a
 * roster of concurrent spawns never serializes on the host event loop; test
 * fakes may stay synchronous — callers always `await` the result.
 */
export type CommandRunner = (
  command: string,
  args: readonly string[],
  options?: CommandOptions,
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
  resetProbeTimeoutsForTests();
}
