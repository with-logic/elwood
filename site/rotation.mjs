export const wrapAngle = (angle) => ((((angle + 180) % 360) + 360) % 360) - 180;
export const angleDelta = (from, to) => wrapAngle(to - from);

export function turnAngle(turn, interpolation = 0) {
  const t = Math.min(1, (turn.elapsed + interpolation) / turn.duration);
  return turn.from + turn.delta * (t * t * (3 - 2 * t));
}

export function nearestAngle(angles, angle) {
  let best = 0;
  let distance = Number.POSITIVE_INFINITY;
  for (let i = 0; i < angles.length; i++) {
    const candidate = Math.abs(angleDelta(angle, angles[i]));
    if (candidate < distance) {
      distance = candidate;
      best = i;
    }
  }
  return best;
}

export function mirroredPose(clip, facing, frame = {}) {
  const mirror =
    clip.mirror !== false && (clip.direction === 0 ? facing === -1 : clip.direction !== facing);
  return !!frame.flip !== mirror;
}
