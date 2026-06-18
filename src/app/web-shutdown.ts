/**
 * Shutdown handling for the browser dev app.
 * Implements PRD §11.
 */

import { spawnSync } from "node:child_process";

type ShutdownSignal = "SIGINT" | "SIGTERM" | "SIGHUP" | "SIGTSTP" | "SIGTTIN" | "SIGTTOU";
type ExitSignal = "SIGKILL";

type ShutdownProcess = {
  readonly pid: number;
  on?(signal: ShutdownSignal | "exit", handler: () => void): unknown;
  once?(signal: ShutdownSignal | "exit", handler: () => void): unknown;
  kill(pid: number, signal: ExitSignal): unknown;
  exit(code: number): never;
};

type ShutdownTimer = ReturnType<typeof setTimeout> & { unref?: () => void };
type KillTree = (pid: number, includeRoot: boolean) => void;

const shutdownSignals: readonly ShutdownSignal[] = [
  "SIGINT",
  "SIGTERM",
  "SIGHUP",
  "SIGTSTP",
  "SIGTTIN",
  "SIGTTOU",
];

export type ShutdownOptions = {
  readonly cleanup?: () => void | Promise<void>;
  readonly cleanupSync?: () => void;
  readonly processLike?: ShutdownProcess;
  readonly hardKillMs?: number;
  readonly killTree?: KillTree;
};

export function installHardShutdown(options: ShutdownOptions = {}): void {
  const processLike = options.processLike ?? process;
  const cleanup = options.cleanup ?? (() => undefined);
  const cleanupSync = options.cleanupSync ?? (() => undefined);
  const killTree = options.killTree ?? killProcessTreeSync;
  let shuttingDown = false;
  const shutdown = (code: number) => {
    if (shuttingDown) return forceKill(processLike, killTree);
    shuttingDown = true;
    const shutdownOptions = {
      processLike,
      cleanup,
      code,
      killTree,
      ...(options.hardKillMs === undefined ? {} : { hardKillMs: options.hardKillMs }),
    };
    void runShutdown(shutdownOptions).catch(() => undefined);
  };
  register(processLike, "SIGINT", () => forceKill(processLike, killTree));
  for (const signal of shutdownSignals.filter((signal) => signal !== "SIGINT"))
    register(processLike, signal, () => shutdown(exitCode(signal)));
  register(processLike, "exit", () => {
    cleanupSync();
    killTree(processLike.pid, false);
  });
}

export async function runShutdown(options: {
  readonly processLike: ShutdownProcess;
  readonly cleanup: () => void | Promise<void>;
  readonly code: number;
  readonly killTree?: KillTree;
  readonly hardKillMs?: number;
}): Promise<never> {
  const killTree = options.killTree ?? killProcessTreeSync;
  let timer: ShutdownTimer | undefined;
  try {
    timer = setTimeout(() => {
      try {
        forceKill(options.processLike, killTree);
      } catch {
        // The process should be gone; tests may use a fake process that throws.
      }
    }, options.hardKillMs ?? 2_500);
    timer.unref?.();
    await options.cleanup();
  } finally {
    if (timer) clearTimeout(timer);
    killTree(options.processLike.pid, false);
    options.processLike.exit(options.code);
  }
}

export function killProcessTreeSync(pid: number, includeRoot: boolean): void {
  for (const child of childPids(pid)) killProcessTreeSync(child, true);
  if (!includeRoot) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Process may have already exited.
  }
}

function forceKill(processLike: ShutdownProcess, killTree: KillTree): never {
  killTree(processLike.pid, false);
  processLike.kill(processLike.pid, "SIGKILL");
  return processLike.exit(137);
}

function register(
  processLike: ShutdownProcess,
  signal: ShutdownSignal | "exit",
  handler: () => void,
): void {
  if (processLike.on) processLike.on(signal, handler);
  else processLike.once?.(signal, handler);
}

function exitCode(signal: ShutdownSignal): number {
  if (signal === "SIGTERM") return 143;
  if (signal === "SIGHUP") return 129;
  return 130;
}

function childPids(pid: number): readonly number[] {
  const result = spawnSync("pgrep", ["-P", String(pid)], { encoding: "utf8" });
  if (result.status !== 0) return [];
  return result.stdout
    .split(/\s+/)
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0);
}
