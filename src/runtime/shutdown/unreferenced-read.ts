/**
 * Process-table reads that never keep the host alive, for the background reap of what a
 * failed walk recorded (PRD §5.3, C-LIFE-14): a host left with nothing else to do exits
 * at once, whatever the reap is waiting on.
 */

import { execFile } from "node:child_process";
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
  const timer = setTimeout(() => running.child.kill(options.killSignal), timeout);
  timer.unref();
  running.child.unref();
  for (const pipe of [running.child.stdout, running.child.stderr]) (pipe as Socket).unref();
  return running.finally(() => clearTimeout(timer));
};

/** The listing for reaps in the background, shared the same way, never keeping the host alive. */
export const listProcessTableUnreferenced = coalesceUnstarted(
  (timeoutMs) => listProcessTable(timeoutMs, runFileUnreferenced),
  { ref: false },
);
