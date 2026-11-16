/** One decode worker, as the older decoder suites assume, so dispatch order is observable (PRD §13).
 * Importing this changes `spriteLimits` for every decoder the importing test file constructs.
 * Pool behavior has its own tests.
 */
import { spriteLimits } from "../../sprite-limits.mjs";

spriteLimits.maxDecodeWorkers = 1;
