/**
 * Caps how many probe shells run at once in this process. Each probe starts an interactive
 * login shell, and a heavy profile is CPU-bound: one took about 2 s at 4 concurrent shells and
 * 7-19 s at 16 on a loaded host. Without a cap, a fleet starting in many directories would start
 * a shell for every probe at once and slow all of them. Implements PRD §9.2 and C-PERF-07.
 */

import { addAbortListener } from "node:events";

/**
 * At most this many probes run at once; the rest wait their turn in arrival order. Eight keeps a
 * heavy profile near 5 s per probe on a loaded 16-CPU host, against about 2 s at four and 7-19 s
 * at sixteen, so a cold fleet still starts eight sessions at a time while each stays well inside
 * its 60 s launch bound (C-PERF-05). The measurements are in docs/cli-behavior.md, "Probe shell
 * startup under concurrency".
 */
export const maxConcurrentProbes = 8;

let running = 0;

type Waiter = {
  readonly admit: () => void;
  previous: Waiter | undefined;
  next: Waiter | undefined;
};

let firstWaiter: Waiter | undefined;
let lastWaiter: Waiter | undefined;

/** Runs `probe` once a slot is free, and frees the slot when it settles either way. */
export async function withProbeSlot<T>(probe: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  if (running < maxConcurrentProbes) running += 1;
  else await waitForProbeSlot(signal);
  try {
    signal?.throwIfAborted();
    return await probe();
  } finally {
    // Hand the slot straight to the longest waiter, so a newcomer cannot take it first.
    const next = firstWaiter;
    if (next) {
      removeWaiter(next);
      next.admit();
    } else running -= 1;
  }
}

function waitForProbeSlot(signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const waiter: Waiter = {
      admit: () => {
        abortListener?.[Symbol.dispose]();
        resolve();
      },
      previous: lastWaiter,
      next: undefined,
    };
    const abortListener = signal
      ? addAbortListener(signal, () => {
          removeWaiter(waiter);
          reject(signal.reason);
        })
      : undefined;
    if (lastWaiter) lastWaiter.next = waiter;
    else firstWaiter = waiter;
    lastWaiter = waiter;
  });
}

function removeWaiter({ previous, next }: Waiter): void {
  if (previous) previous.next = next;
  else firstWaiter = next;
  if (next) next.previous = previous;
  else lastWaiter = previous;
}
