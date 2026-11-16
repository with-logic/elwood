/** A four-sheet decoded cache, as the older ownership suites assume, so small fixtures reach eviction (PRD §13).
 * Importing this changes `spriteLimits` for every bank the importing test file constructs.
 * Fixture images carry no dimensions, so each is charged as one full sheet: four pages.
 */
import { DECODED_SHEET_BYTES, spriteLimits } from "../../sprite-limits.mjs";

spriteLimits.cacheLimitBytes = 4 * DECODED_SHEET_BYTES;
