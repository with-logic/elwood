/** Release velocity of a pointer drag, so letting go mid-motion carries the robot along (PRD §13.4).
 *
 * All speeds are world pixels per second. The held robot's speed is measured first and the
 * robot then keeps a share of it: held at 400 he is released at 140; held at 150, the slowest
 * that counts, at 52.5; held at 1,200 or more, at the 420 ceiling.
 */

/** The held robot's velocity is measured over the pointer movement this recent. */
const WINDOW_MS = 100;
/** A pointer whose last movement is older than this at release had stopped: plain drop. */
const STALE_MS = 60;
/** Held speed, before the share is taken, below which a release is a plain drop. */
const MIN_HELD_SPEED = 150;
/** The robot is heavy: he keeps this share of his held velocity. */
const RELEASE_SHARE = 0.35;
/** Ceiling on the speed he is released at, after the share is taken. */
const MAX_RELEASED_SPEED = 420;

/** Record where the held robot was (`x`, `y`) at a pointer event (`timeMs` is its
 * `timeStamp`), keeping only the window before this latest movement.
 */
export function recordDragSample(samples, { timeMs, x, y }) {
  samples.push({ timeMs, x, y });
  while (timeMs - samples[0].timeMs > WINDOW_MS) samples.shift();
}

/** Velocity at release, or null when the release is not a throw. `releaseTimeMs` is the
 * release event's `timeStamp`; releases that are not a pointer release pass none.
 */
export function throwVelocity(samples, releaseTimeMs) {
  if (!Number.isFinite(releaseTimeMs)) return null;
  const first = samples[0];
  const last = samples.at(-1);
  if (samples.length < 2 || releaseTimeMs - last.timeMs > STALE_MS) return null;
  const seconds = (last.timeMs - first.timeMs) / 1000;
  if (!(seconds > 0)) return null;
  const x = (last.x - first.x) / seconds;
  const y = (last.y - first.y) / seconds;
  const heldSpeed = Math.hypot(x, y);
  if (heldSpeed < MIN_HELD_SPEED) return null;
  const share = Math.min(RELEASE_SHARE, MAX_RELEASED_SPEED / heldSpeed);
  return { x: x * share, y: y * share };
}
