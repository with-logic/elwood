/**
 * Shutdown handling for the browser dev app.
 * Implements PRD §11.
 */

import { childPids } from "../child-lookup.ts";

export type { ChildLookupDiagnostic } from "../child-lookup.ts";
export { classifyChildLookup, setChildLookupReporter } from "../child-lookup.ts";

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
  const timer: ShutdownTimer = setTimeout(() => {
    try {
      forceKill(options.processLike, killTree);
    } catch {
      // The process should be gone; tests may use a fake process that throws.
    }
  }, options.hardKillMs ?? 2_500);
  timer.unref?.();
  try {
    await options.cleanup();
  } finally {
    clearTimeout(timer);
    killTree(options.processLike.pid, false);
    options.processLike.exit(options.code);
  }
}

export function killProcessTreeSync(pid: number, includeRoot: boolean): void {
  // Dev web app teardown (PRD §11): the elwood process is tearing itself down
  // and must SIGKILL its descendants (e.g. supervised PTY children) — including
  // when reaping its OWN pid, where a process-group kill would suicide the
  // process before it finishes shutting down. A parent-pid walk is the only way
  // to reap descendants without signaling self. This is the dev tool, not the
  // shipped session path (session teardown reaps by process group, reap-tree.ts).
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
