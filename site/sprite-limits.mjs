/** Decoded-memory and decode-concurrency bounds for sprite banks (PRD §13; docs/design/landing.md). */

/** Decoded size of one full 2048-pixel RGBA sheet: the unit of the cache budget. */
export const DECODED_SHEET_BYTES = 2048 * 2048 * 4;

const isPixelCount = (value) => Number.isInteger(value) && value > 0;

/** Decoded size of one page. A page whose size is missing or invalid is charged as a full sheet. */
export const decodedPageBytes = (page) =>
  isPixelCount(page.width) && isPixelCount(page.height) ? page.width * page.height * 4 : DECODED_SHEET_BYTES;

/** Decoded size of every page of a clip, from its metadata. */
export const decodedClipBytes = (clip) =>
  clip.pages.reduce((bytes, page) => bytes + decodedPageBytes(page), 0);

/** Ceiling on decode workers. Explicit preparation fetches four pages at a time, so a
 * fifth worker would sit idle, and each one holds a decoded sheet while it works.
 */
export const MAX_DECODE_WORKERS = 4;

/** The bounds for a device. Browsers that report neither value get twelve sheets and one worker. */
export function limitsFor({ deviceMemory, hardwareConcurrency } = {}) {
  return {
    // Twelve sheets hold idle, rotation, both walks, the side stances, landing, the jump and
    // the suspended pickup at once. Six hold all of those except the jump and the pickup.
    // The four pages held before lost a walk sheet on every change of direction.
    cacheLimitBytes: (deviceMemory <= 4 ? 6 : 12) * DECODED_SHEET_BYTES,
    // One worker needs over a second for a nine-sheet action (about 150 ms a sheet).
    // Leave a core for painting when the device has more than one.
    maxDecodeWorkers: Math.min(MAX_DECODE_WORKERS, Math.max(1, (hardwareConcurrency ?? 2) - 1)),
  };
}

/** Read when a bank or decoder is constructed. Tests lower these to reach eviction and
 * observe dispatch order.
 */
export const spriteLimits = limitsFor(globalThis.navigator);
