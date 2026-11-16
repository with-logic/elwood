/** Decoded-memory and decode-concurrency bounds for sprite banks (PRD §13; docs/design/landing.md). */

/** Decoded size of one full 2048-pixel RGBA sheet: the unit of the cache budget. */
export const DECODED_SHEET_BYTES = 2048 * 2048 * 4;

/** Decoded size of one page. A page of unknown size is charged as a full sheet. */
export const decodedPageBytes = (page) =>
  page.width && page.height ? page.width * page.height * 4 : DECODED_SHEET_BYTES;

/** Decoded size of every page of a clip, from its metadata. */
export const decodedClipBytes = (clip) =>
  clip.pages.reduce((bytes, page) => bytes + decodedPageBytes(page), 0);

/** The bounds for a device. Browsers that report neither value get twelve sheets and one worker. */
export function limitsFor({ deviceMemory, hardwareConcurrency } = {}) {
  return {
    // Twelve sheets hold idle, rotation, both walks, the jump and the suspended pickup at once.
    // Fewer than that evicts a walk sheet on every change of direction.
    cacheLimitBytes: (deviceMemory <= 4 ? 6 : 12) * DECODED_SHEET_BYTES,
    // One worker needs over a second for a nine-sheet action (about 150 ms a sheet).
    // Leave a core for painting.
    maxDecodeWorkers: Math.min(4, Math.max(1, (hardwareConcurrency ?? 2) - 1)),
  };
}

/** Read when a bank is constructed. Tests lower these to exercise eviction and queueing. */
export const spriteLimits = limitsFor(globalThis.navigator);
