/** Reject unrenderable clip metadata before caching (PRD §13; docs/design/landing.md). */
export function validateSpriteClip(clip) {
  const valid = clip && Number.isFinite(clip.fps) && clip.fps > 0
    && Array.isArray(clip.pages) && clip.pages.length > 0
    && clip.pages.every((page) => typeof page?.file === "string" && page.file.trim())
    && Array.isArray(clip.frames) && clip.frames.length > 0
    && clip.frames.every((frame) => frame
      && Number.isInteger(frame.page) && frame.page >= 0 && frame.page < clip.pages.length
      && [frame.x, frame.y, frame.w, frame.h, frame.anchor?.x, frame.anchor?.y,
        frame.socket?.x, frame.socket?.y].every(Number.isFinite)
      && frame.x >= 0 && frame.y >= 0 && frame.w > 0 && frame.h > 0);
  if (!valid) throw new Error("Invalid animation metadata.");
}
