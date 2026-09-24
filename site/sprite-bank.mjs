/** On-demand sprite ownership and retry control (site/docs/design/landing.md; PRD §13). */
import { SpriteAnimations } from "./sprite-animations.mjs";
import { SpritePages } from "./sprite-pages.mjs";
import { SpriteLoads } from "./sprite-loads.mjs";
import { validateSpriteClip } from "./sprite-metadata.mjs";
import { SpriteDecoder } from "./sprite-decoder/index.mjs";
import { releaseSpriteImage } from "./sprite-decoder/release.mjs";
import { gameAssetUrl } from "./game-assets.mjs";
import { withSpriteAssetErrorContext } from "./sprite-asset-error.mjs";

export class SpriteBank {
  constructor(onError) {
    this.decoder = new SpriteDecoder();
    this.animations = new SpriteAnimations(this);
    this.clips = new Map();
    this.clipPromises = new Map();
    this.resources = new SpritePages();
    this.pages = this.resources.cached;
    this.pendingPages = new Map();
    this.disposed = false;
    this.loads = new SpriteLoads(this, onError);
  }

  async load(name, options = {}) {
    options.signal?.throwIfAborted();
    if (this.disposed) throw new Error("Sprite bank is disposed.");
    if (this.clips.has(name)) return this.clips.get(name);
    return this.loads.run(name, this.clipPromises, async (signal) => {
      const clip = await withSpriteAssetErrorContext(`${name}/clip.json`, async () => {
        const response = await fetch(gameAssetUrl(`${name}/clip.json`), { signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const value = await response.json();
        if (this.disposed) throw new Error("Sprite bank is disposed.");
        validateSpriteClip(value);
        return value;
      });
      signal.throwIfAborted();
      return clip;
    }, options, { publish: (clip) => this.clips.set(name, clip) });
  }

  async loadPage(name, index, options = {}) {
    options.signal?.throwIfAborted();
    if (this.disposed) throw new Error("Sprite bank is disposed.");
    const key = `${name}/${index}`;
    const cached = this.resources.acquirePage(key, options.signal);
    if (cached) return cached;
    return this.loads.run(key, this.pendingPages, async (signal) => {
      const clip = await this.load(name, { signal });
      signal.throwIfAborted();
      const path = `${name}/${clip.pages[index].file}`;
      const image = await withSpriteAssetErrorContext(path, async () => {
        const response = await fetch(gameAssetUrl(path), { signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return this.decoder.decode(await response.blob(), signal);
      });
      return image;
    }, options, {
      publish: (image, pin) => { pin(image); this.resources.store(key, image); },
      discard: releaseSpriteImage,
    });
  }

  async prepare(name, options = {}) {
    options.signal?.throwIfAborted();
    const owner = options.signal ? null : new AbortController();
    const signal = options.signal ?? owner.signal;
    this.loads.retry(name);
    try {
      const clip = await this.load(name, { signal });
      await this.loadPage(name, clip.frames[0].page, { signal });
      return clip;
    } finally { owner?.abort(); }
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

  pinLoadPage(key, image, signal) { this.resources.pin(key, image, signal); }

  ensureMetadata(name) {
    if (!this.clips.has(name)) this.loads.request(name, (options) => this.load(name, options));
  }

  #requestPage(name, index) {
    const key = `${name}/${index}`;
    if (!this.pages.has(key)) this.loads.request(key, (options) => this.loadPage(name, index, options));
  }

  ensureEntryPage(name) {
    const clip = this.clips.get(name);
    if (!clip) {
      this.loads.request(name, (options) => this.load(name, options).then((loaded) => {
        this.#requestPage(name, loaded.frames[0].page);
      }));
      return false;
    }
    if (this.animations.page(`${name}/${clip.frames[0].page}`)) return true;
    this.#requestPage(name, clip.frames[0].page);
    return this.pages.has(`${name}/${clip.frames[0].page}`);
  }

  /** Replace both pose owners atomically; rendering borrows their pages synchronously. */
  retainPoses(...poses) {
    if (!this.disposed) this.resources.retainPoses(...poses);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.animations.dispose();
    this.resources.dispose();
    this.loads.dispose();
    this.clips.clear();
    this.clipPromises.clear();
    this.pendingPages.clear();
    this.decoder?.dispose?.();
  }

  frame(name, index) {
    if (this.disposed) return null;
    const clip = this.clips.get(name);
    if (!clip) {
      this.ensureEntryPage(name);
      return null;
    }
    const frame = clip.frames[Math.min(index, clip.frames.length - 1)];
    const key = `${name}/${frame.page}`;
    const owned = this.animations.page(key);
    if (owned) return { clip, frame, page: owned };
    const page = this.pages.get(key);
    if (!page) {
      this.#requestPage(name, frame.page);
      return null;
    }
    this.pages.delete(key);
    this.pages.set(key, page);
    const nextPage = clip.frames[Math.min(index + 16, clip.frames.length - 1)].page;
    const nextKey = `${name}/${nextPage}`;
    if (nextPage !== frame.page && !this.pages.has(nextKey) && !this.pendingPages.has(nextKey))
      this.#requestPage(name, nextPage);
    return { clip, frame, page };
  }
}
