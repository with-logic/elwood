import { mirroredPose } from "./rotation.mjs";

export function samePoseImage(a, b) {
  if (!(a && b) || a.mirrored !== b.mirrored || a.x !== b.x || a.y !== b.y) return false;
  const af = a.frame;
  const bf = b.frame;
  const sameSource = af.source_image
    ? af.source_image === bf.source_image
    : af.source_clip && af.source_clip === bf.source_clip && af.source_frame === bf.source_frame;
  return (
    !!sameSource &&
    af.w === bf.w &&
    af.h === bf.h &&
    af.anchor.x === bf.anchor.x &&
    af.anchor.y === bf.anchor.y
  );
}

export function positionPose(pose, player) {
  const ledge = pose.clip.registration === "ledge" ? player.ledge : null;
  return {
    ...pose,
    x: ledge ? ledge.edge : player.x,
    y: ledge ? ledge.platform.top : player.y,
    mirrored: mirroredPose(pose.clip, player.facing, pose.frame),
  };
}

export function socketPosition(pose, scale) {
  return {
    x: pose.x + pose.frame.socket.x * scale * (pose.mirrored ? -1 : 1),
    y: pose.y + pose.frame.socket.y * scale,
  };
}

export function blendAtSocket(incoming, outgoing, blend, scale) {
  const end = socketPosition(incoming, scale);
  if (!outgoing || blend >= 1) return { incoming, outgoing: null, endpoint: end };
  const start = socketPosition(outgoing, scale);
  const endpoint = {
    x: start.x + (end.x - start.x) * blend,
    y: start.y + (end.y - start.y) * blend,
  };
  // Both images in a pose blend share the visible connector. The tether can
  // therefore remain attached throughout the blend, including mirrored poses.
  const align = (pose, socket) => ({
    ...pose,
    x: pose.x + endpoint.x - socket.x,
    y: pose.y + endpoint.y - socket.y,
  });
  return { incoming: align(incoming, end), outgoing: align(outgoing, start), endpoint };
}

// The outgoing frame keeps its own anchor. A climb is registered to a ledge,
// whereas its standing successor is registered to the feet; assigning both
// the player's position would teleport the outgoing image during the blend.
export function transitionPose(transition, player) {
  return {
    ...transition.pose,
    x: transition.pose.x + (player.x - transition.playerX),
    y: transition.pose.y + (player.y - transition.playerY),
  };
}
