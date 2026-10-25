/**
 * Caps how many probe shells run at once in this process. Each probe starts an interactive
 * login shell, and a heavy profile is CPU-bound: one took about 2 s at 4 concurrent shells and
 * 7-19 s at 16 on a loaded host. Without a cap, a fleet starting in many directories would start
 * a shell for every probe at once and slow all of them. Implements PRD §9.2 and C-PERF-07.
 */

/** At most this many probes run at once; the rest wait their turn in arrival order. */
export const maxConcurrentProbes = 8;

let running = 0;
const waiting: (() => void)[] = [];

/** Runs `probe` once a slot is free, and frees the slot when it settles either way. */
export async function withProbeSlot<T>(probe: () => Promise<T>): Promise<T> {
  if (running < maxConcurrentProbes) running += 1;
  else await new Promise<void>((resolve) => waiting.push(resolve));
  try {
    return await probe();
  } finally {
    // Hand the slot straight to the longest waiter, so a newcomer cannot take it first.
    const next = waiting.shift();
    if (next) next();
    else running -= 1;
  }
}
