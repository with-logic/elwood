/** Compute the freshness deadline for a quota observation (PRD §5.12, C-STATS-04/06). */
import type { UsageWindow } from "./types.ts";

const quotaLifetimeMs = 5 * 60_000;

export type UsageDeadline = { readonly epochMs: number; readonly monotonicMs: number };

export function usageDeadline(
  observedAtMs: number,
  windows: readonly UsageWindow[],
): UsageDeadline {
  // A reading expires at its earliest reset or five minutes after observation.
  const epochMs = windows.reduce(
    (until, window) =>
      window.resetsAt === undefined ? until : Math.min(until, Date.parse(window.resetsAt)),
    observedAtMs + quotaLifetimeMs,
  );
  // The monotonic deadline prevents wall-clock rollbacks from delaying expiry.
  return { epochMs, monotonicMs: performance.now() + (epochMs - Date.now()) };
}

export function usageIsFresh(deadline: UsageDeadline): boolean {
  return performance.now() < deadline.monotonicMs && Date.now() < deadline.epochMs;
}
