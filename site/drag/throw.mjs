/** Release velocity of a pointer drag, so letting go mid-motion carries the robot along (PRD §13.4). */

/** Only motion this recent counts: a pointer that stopped before release drops straight down. */
const WINDOW_MS = 100;
const STALE_MS = 60;
/** World pixels per second of pointer movement below which a release is a plain drop. */
export const MIN_POINTER_SPEED = 150;
/** The robot is heavy: he keeps this share of the pointer's velocity, up to a low ceiling. */
export const THROW_SHARE = 0.35;
export const MAX_THROW_SPEED = 420;

/** Record where the robot was at a pointer event, keeping only the recent window. */
export function recordDragSample(samples, time, x, y) {
  samples.push({ time, x, y });
  while (samples.length > 1 && time - samples[0].time > WINDOW_MS) samples.shift();
}

/** Velocity at release in world pixels per second, or null when the release is not a throw. */
export function throwVelocity(samples, time) {
  if (!Number.isFinite(time)) return null;
  const recent = samples.filter((sample) => time - sample.time <= WINDOW_MS);
  const first = recent[0];
  const last = recent.at(-1);
  if (recent.length < 2 || time - last.time > STALE_MS) return null;
  const seconds = (last.time - first.time) / 1000;
  if (!(seconds > 0)) return null;
  const x = (last.x - first.x) / seconds;
  const y = (last.y - first.y) / seconds;
  const speed = Math.hypot(x, y);
  if (speed < MIN_POINTER_SPEED) return null;
  const scale = Math.min(THROW_SHARE, MAX_THROW_SPEED / speed);
  return { x: x * scale, y: y * scale };
}
