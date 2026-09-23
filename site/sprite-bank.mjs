/** Complete-animation ownership over shared sprite assets (PRD §13; docs/design/landing.md). */
import { SpriteCache } from "./sprite-cache.mjs";
import { SpriteAnimations } from "./sprite-animations.mjs";

export class SpriteBank extends SpriteCache {
  constructor(onError) {
    super(onError);
    this.animations = new SpriteAnimations(this);
  }

  /** Resolves the complete clip, null on cancellation/teardown, or rejects an asset failure. */
  prepareAnimation(name) {
    if (this.disposed) return Promise.reject(new Error("Sprite bank is disposed."));
    return this.animations.prepare(name);
  }

  publishAnimation(name) { this.animations.publish(name); }
  activateAnimation(name) { this.animations.activate(name); }
  /** Cancel pending/delivered preparation while active playback keeps its owner. */
  cancelPreparation() { this.animations.cancel(); }

  ensureEntryPage(name) {
    const frame = this.clips.get(name)?.frames[0];
    if (frame && this.animations.page(`${name}/${frame.page}`)) return true;
    return super.ensureEntryPage(name);
  }

  frame(name, index) {
    const clip = this.clips.get(name);
    const frame = clip?.frames[Math.min(index, clip.frames.length - 1)];
    const page = frame && this.animations.page(`${name}/${frame.page}`);
    return page ? { clip, frame, page } : super.frame(name, index);
  }

  dispose() {
    this.animations.dispose();
    super.dispose();
  }
}
