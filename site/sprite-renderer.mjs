function drawPose(context, pose, scale, opacity = 1) {
  const { frame, page } = pose;
  context.save();
  context.translate(pose.x, pose.y);
  context.scale(pose.mirrored ? -scale : scale, scale);
  context.globalAlpha = opacity;
  context.drawImage(
    page,
    frame.x,
    frame.y,
    frame.w,
    frame.h,
    -frame.anchor.x,
    -frame.anchor.y,
    frame.w,
    frame.h,
  );
  context.restore();
}

function bounds(pose, scale) {
  const { frame, mirrored } = pose;
  const x = pose.x + (mirrored ? frame.anchor.x - frame.w : -frame.anchor.x) * scale;
  const y = pose.y - frame.anchor.y * scale;
  return { x, y, right: x + frame.w * scale, bottom: y + frame.h * scale };
}

export class SpriteRenderer {
  constructor(context, blendCanvas) {
    this.context = context;
    this.canvas = blendCanvas;
    this.blendContext = blendCanvas.getContext("2d");
  }

  draw(incoming, outgoing, blend, scale, density = 1) {
    if (!incoming) return;
    if (!outgoing || blend >= 1) {
      drawPose(this.context, incoming, scale);
      return;
    }
    if (blend <= 0) {
      drawPose(this.context, outgoing, scale);
      return;
    }

    const a = bounds(incoming, scale);
    const b = bounds(outgoing, scale);
    const { e: offsetX, f: offsetY } = this.context.getTransform();
    const left = Math.floor(Math.min(a.x, b.x) * density + offsetX) - 1;
    const top = Math.floor(Math.min(a.y, b.y) * density + offsetY) - 1;
    const width = Math.ceil(Math.max(a.right, b.right) * density + offsetX) - left + 1;
    const height = Math.ceil(Math.max(a.bottom, b.bottom) * density + offsetY) - top + 1;
    // Reuse a character-sized buffer at display resolution. Grow in chunks
    // so a changing silhouette does not reallocate a canvas every frame.
    if (this.canvas.width < width) this.canvas.width = Math.ceil(width / 64) * 64;
    if (this.canvas.height < height) this.canvas.height = Math.ceil(height / 64) * 64;
    const buffer = this.blendContext;
    buffer.setTransform(1, 0, 0, 1, 0, 0);
    buffer.clearRect(0, 0, this.canvas.width, this.canvas.height);
    // Include camera translation to land on the same physical pixel grid as
    // a direct sprite draw, avoiding an extra resample while the camera moves.
    buffer.setTransform(density, 0, 0, density, offsetX - left, offsetY - top);
    buffer.globalCompositeOperation = "source-over";
    drawPose(buffer, outgoing, scale, 1 - blend);
    // Sum premultiplied colors AND alpha before compositing onto the world.
    // Two source-over draws at complementary alpha leak 25% of the pale
    // background at the midpoint, even when both source pixels are opaque.
    buffer.globalCompositeOperation = "lighter";
    drawPose(buffer, incoming, scale, blend);
    this.context.drawImage(
      this.canvas,
      0,
      0,
      width,
      height,
      (left - offsetX) / density,
      (top - offsetY) / density,
      width / density,
      height / density,
    );
  }
}
