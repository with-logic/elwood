/** Owns cached and pose-retained sprite resources (PRD §13; docs/design/landing.md). */
import { SpriteLoads } from "./sprite-loads.mjs";
import { SpriteAnimations } from "./sprite-animations.mjs";
import { validateSpriteClip } from "./sprite-metadata.mjs";
import { gameAssetUrl } from "./game-assets.mjs";
import { SpriteDecoder } from "./sprite-decoder/index.mjs";
import { releaseSpriteImage } from "./sprite-decoder/release.mjs";

export class SpriteBank {
  #retained = new Set();
  #evicted = new Set();
  constructor(onError) {
    this.decoder = new SpriteDecoder();
    this.animations = new SpriteAnimations(this);
    this.clips = new Map();
    this.clipPromises = new Map();
    this.pages = new Map();
    this.pendingPages = new Map();
    this.disposed = false;
    this.loads = new SpriteLoads(this, onError);
  }

  async load(name) {
    if (this.disposed) throw new Error("Sprite bank is disposed.");
    if (this.clips.has(name)) return this.clips.get(name);
    if (this.clipPromises.has(name)) return this.clipPromises.get(name);
    const promise = (async () => {
      const response = await fetch(gameAssetUrl(`${name}/clip.json`));
      if (!response.ok)
        throw new Error(`Couldn’t load ${name}. Check the local server and try again.`);
      const clip = await response.json();
      if (this.disposed) throw new Error("Sprite bank is disposed.");
      validateSpriteClip(clip, name);
      this.loads.accept(name);
      this.clips.set(name, clip);
      return clip;
    })();
    return this.loads.track(name, promise, this.clipPromises);
  }

  async loadPage(name, index) {
    if (this.disposed) throw new Error("Sprite bank is disposed.");
    const key = `${name}/${index}`;
    if (this.pages.has(key)) {
      const page = this.pages.get(key);
      this.pages.delete(key);
      this.pages.set(key, page);
      return page;
    }
    if (this.pendingPages.has(key)) return this.pendingPages.get(key);
    const promise = (async () => {
      const clip = await this.load(name);
      if (this.disposed) throw new Error("Sprite bank is disposed.");
      const response = await fetch(gameAssetUrl(`${name}/${clip.pages[index].file}`));
      if (!response.ok)
        throw new Error(`Couldn’t load ${name}. Check the local server and try again.`);
      const image = await this.decoder.decode(await response.blob());
      if (this.disposed) {
        releaseSpriteImage(image);
        throw new Error("Sprite bank is disposed.");
      }
      this.loads.accept(key);
      this.pages.set(key, image);
      // Poses and active, delivered, or candidate animation owners may retain evicted pages.
      while (this.pages.size > 4) {
        const oldest = this.pages.keys().next().value;
        const evicted = this.pages.get(oldest);
        this.pages.delete(oldest);
        if (this.#retained.has(evicted) || this.animations.owns(evicted)) this.#evicted.add(evicted);
        else releaseSpriteImage(evicted);
      }
      return image;
    })();
    return this.loads.track(key, promise, this.pendingPages);
  }

  async prepare(name) {
    this.loads.retry(name);
    const clip = await this.load(name);
    this.loads.claim(`${name}/${clip.frames[0].page}`);
    await this.loadPage(name, clip.frames[0].page);
    return clip;
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

  releaseAnimationPage(image) {
    if (this.animations.owns(image) || [...this.pages.values()].includes(image)) return;
    if (this.#retained.has(image)) this.#evicted.add(image);
    else {
      this.#evicted.delete(image);
      releaseSpriteImage(image);
    }
  }

  ensureMetadata(name) {
    if (!this.clips.has(name)) this.loads.request(name, () => this.load(name));
  }

  #requestPage(name, index) {
    const key = `${name}/${index}`;
    if (!this.animations.page(key) && !this.pages.has(key)) this.loads.request(key, () => this.loadPage(name, index));
  }

  ensureEntryPage(name) {
    const clip = this.clips.get(name);
    if (!clip) {
      this.loads.request(name, () => this.load(name).then((loaded) => {
        this.#requestPage(name, loaded.frames[0].page);
      }));
      return false;
    }
    this.#requestPage(name, clip.frames[0].page);
    return !!this.animations.page(`${name}/${clip.frames[0].page}`) || this.pages.has(`${name}/${clip.frames[0].page}`);
  }

  /** Replace both pose owners atomically; rendering borrows their pages synchronously. */
  retainPoses(...poses) {
    if (this.disposed) return;
    this.#retained = new Set(poses.filter(Boolean).map((pose) => pose.page));
    for (const page of this.#evicted) {
      if (this.#retained.has(page) || this.animations.owns(page)) continue;
      this.#evicted.delete(page);
      releaseSpriteImage(page);
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.animations.dispose();
    for (const page of new Set([...this.pages.values(), ...this.#evicted])) releaseSpriteImage(page);
    this.loads.dispose();
    this.pages.clear();
    this.#retained.clear();
    this.#evicted.clear();
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
    const page = this.animations.page(key) ?? this.pages.get(key);
    if (!page) {
      this.#requestPage(name, frame.page);
      return null;
    }
    if (this.pages.get(key) === page) {
      this.pages.delete(key);
      this.pages.set(key, page);
    }
    const nextPage = clip.frames[Math.min(index + 16, clip.frames.length - 1)].page;
    const nextKey = `${name}/${nextPage}`;
    if (nextPage !== frame.page && !this.animations.page(nextKey) && !this.pages.has(nextKey) && !this.pendingPages.has(nextKey))
      this.#requestPage(name, nextPage);
    return { clip, frame, page };
  }
}
