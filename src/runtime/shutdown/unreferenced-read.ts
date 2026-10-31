/**
 * Process-table reads that never keep the host alive, for the background reap of what a
 * failed walk recorded (PRD §5.3, C-LIFE-14): a host left with nothing else to do exits
 * at once, whatever the reap is waiting on.
 */

import { execFile, type PromiseWithChild } from "node:child_process";
import type { Socket } from "node:net";
import { promisify } from "node:util";
import { coalesceUnstarted } from "./coalesce.ts";
import { listProcessTable, type PsRunner } from "./process-table.ts";

/**
 * `runFile`, but nothing it starts keeps the host alive: not the `ps`, its pipes, or its
 * timeout, which `execFile` would hold on a timer of its own.
 */
export const runFileUnreferenced: PsRunner = (file, args, { timeout, ...options }) => {
  const running = promisify(execFile)(file, [...args], options);
  return settleUnreferenced(running, timeout, options.killSignal);
};

/** Observes rejection before touching nullable process pipes or other setup handles. */
export async function settleUnreferenced<T>(
  running: PromiseWithChild<T>,
  timeoutMs: number,
  signal: "SIGKILL",
): Promise<T> {
  const observed = running.catch(() => undefined);
  const timer = setTimeout(() => running.child.kill(signal), timeoutMs);
  try {
    try {
      timer.unref();
      running.child.unref();
      for (const pipe of [running.child.stdout, running.child.stderr]) {
        if (pipe) (pipe as Socket).unref();
      }
    } catch (error) {
      // Only an actual spawned child can require cleanup.
      if (running.child.pid !== undefined) running.child.kill(signal);
      await observed;
      throw error;
    }
    return await running;
  } finally {
    clearTimeout(timer);
  }
}

/** The listing for reaps in the background, shared the same way, never keeping the host alive. */
export const listProcessTableUnreferenced = coalesceUnstarted(
  (timeoutMs) => listProcessTable(timeoutMs, runFileUnreferenced),
  { ref: false },
);
