/**
 * Unreferenced native process-table reads for retained recovery (PRD §5.3 and §9.4,
 * C-LIFE-10). This internal foundation is not yet used by session shutdown.
 */

import { execFile, type PromiseWithChild } from "node:child_process";
import type { Socket } from "node:net";
import { promisify } from "node:util";
import { coalesceBeforeNativeAdmission } from "./coalesce-before-native-admission.ts";
import { createAdmittedPsRunner } from "./native-read-admission.ts";
import { listProcessTable, type PsRunner } from "./process-table.ts";

/**
 * `runFile`, but nothing it starts keeps the host alive: not the `ps`, its pipes, or its
 * timeout, which `execFile` would hold on a timer of its own.
 */
export const runFileUnreferencedNative: PsRunner = (file, args, { timeout, ...options }) => {
  const running = promisify(execFile)(file, [...args], options);
  return settleUnreferenced(running, timeout, options.killSignal);
};
export const runFileUnreferenced = createAdmittedPsRunner(runFileUnreferencedNative, {
  ref: false,
});

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

/** Shares queued scans; `run` launches directly because this reader owns native admission. */
export function createUnreferencedProcessTableReader(run: PsRunner) {
  return coalesceBeforeNativeAdmission((timeoutMs) => listProcessTable(timeoutMs, run), {
    ref: false,
  });
}

/** The listing for reaps in the background, shared the same way, never keeping the host alive. */
export const listProcessTableUnreferenced =
  createUnreferencedProcessTableReader(runFileUnreferencedNative);
