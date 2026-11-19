/** Release velocity of a pointer drag, so letting go mid-motion carries the robot along (PRD §13.4). */

/** The held robot's velocity is measured over the pointer movement this recent. */
const WINDOW_MS = 100;
/** A pointer whose last movement is older than this at release had stopped: plain drop. */
const STALE_MS = 60;
/** World pixels per second the held robot must be moving, below which a release is a plain drop. */
const MIN_RELEASE_SPEED = 150;
/** The robot is heavy: he keeps this share of his held velocity. */
export const THROW_SHARE = 0.35;
/** Ceiling on the released speed, in world pixels per second. */
export const MAX_THROW_SPEED = 420;

/** Record where the held robot was at a pointer event (`timeMs` is `event.timeStamp`),
 * keeping only the window before this latest movement.
 */
export function recordDragSample(samples, timeMs, x, y) {
  samples.push({ timeMs, x, y });
  while (timeMs - samples[0].timeMs > WINDOW_MS) samples.shift();
}

/** Velocity at release in world pixels per second, or null when the release is not a throw.
 * `releaseTimeMs` is the release event's `timeStamp`; other releases pass none.
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
  const speed = Math.hypot(x, y);
  if (speed < MIN_RELEASE_SPEED) return null;
  const scale = Math.min(THROW_SHARE, MAX_THROW_SPEED / speed);
  return { x: x * scale, y: y * scale };
}
