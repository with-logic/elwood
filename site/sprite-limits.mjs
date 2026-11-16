/** Decode-concurrency bound for sprite banks (PRD §13; docs/design/landing.md). */

/** The bounds for a device. A browser that reports no processor count gets one worker. */
export function limitsFor({ hardwareConcurrency } = {}) {
  return {
    // One worker needs over a second for a nine-sheet action (about 150 ms a sheet).
    // Leave a core for painting.
    maxDecodeWorkers: Math.min(4, Math.max(1, (hardwareConcurrency ?? 2) - 1)),
  };
}

/** Read when a decoder is constructed. Tests lower this to observe dispatch order. */
export const spriteLimits = limitsFor(globalThis.navigator);
