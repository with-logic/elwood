/** On-demand sprite ownership and retry control (site/docs/design/landing.md; PRD §13). */
import { SpriteLoads } from "./sprite-loads.mjs";
import { validateSpriteClip } from "./sprite-metadata.mjs";
import { SpriteDecoder } from "./sprite-decoder/index.mjs";
import { releaseSpriteImage } from "./sprite-decoder/release.mjs";
import { gameAssetUrl } from "./game-assets.mjs";
import { withSpriteAssetErrorContext } from "./sprite-asset-error.mjs";

export class SpriteBank {
  #retained = new Set();
  #evicted = new Set();
  #leased = new Map();
  constructor(onError) {
    this.decoder = new SpriteDecoder();
    this.clips = new Map();
    this.clipPromises = new Map();
    this.pages = new Map();
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
        validateSpriteClip(value, name);
        return value;
      });
      if (this.disposed) throw new Error("Sprite bank is disposed.");
      signal.throwIfAborted();
      this.clips.set(name, clip);
      return clip;
    }, options);
  }

  async loadPage(name, index, options = {}) {
    options.signal?.throwIfAborted();
    if (this.disposed) throw new Error("Sprite bank is disposed.");
    const key = `${name}/${index}`;
    if (this.pages.has(key)) {
      const page = this.pages.get(key);
      this.pages.delete(key);
      this.pages.set(key, page);
      if (options.signal) this.pinLoadPage(key, page, options.signal);
      return page;
    }
    const retained = [...this.#leased.values()].map((owner) => owner.pages.get(key)).find(Boolean);
    if (retained) {
      if (options.signal) this.pinLoadPage(key, retained, options.signal);
      this.#cachePage(key, retained);
      return retained;
    }
    return this.loads.run(key, this.pendingPages, async (signal, pin) => {
      const clip = await this.load(name, { signal });
      if (this.disposed) throw new Error("Sprite bank is disposed.");
      const path = `${name}/${clip.pages[index].file}`;
      const image = await withSpriteAssetErrorContext(path, async () => {
        const response = await fetch(gameAssetUrl(path), { signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return this.decoder.decode(await response.blob());
      });
      if (this.disposed || signal.aborted) {
        releaseSpriteImage(image);
        signal.throwIfAborted();
        throw new Error("Sprite bank is disposed.");
      }
      pin(image);
      this.#cachePage(key, image);
      return image;
    }, options);
  }

  #cachePage(key, image) {
    this.#evicted.delete(image);
    this.pages.set(key, image);
    // Evicted pages may still belong to the current or outgoing pose.
    while (this.pages.size > 4) {
      const oldest = this.pages.keys().next().value;
      const evicted = this.pages.get(oldest);
      this.pages.delete(oldest);
      if (this.#retained.has(evicted) || this.#loadOwns(evicted)) this.#evicted.add(evicted);
      else releaseSpriteImage(evicted);
    }
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

  pinLoadPage(key, image, signal) {
    let owner = this.#leased.get(signal);
    if (!owner) {
      owner = { pages: new Map(), release: () => {
        this.#leased.delete(signal);
        this.#releaseEvicted();
      } };
      this.#leased.set(signal, owner);
      signal.addEventListener("abort", owner.release, { once: true });
    }
    owner.pages.set(key, image);
  }

  #loadOwns(image) { return [...this.#leased.values()].some((owner) => [...owner.pages.values()].includes(image)); }

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
    this.#requestPage(name, clip.frames[0].page);
    return this.pages.has(`${name}/${clip.frames[0].page}`);
  }

  /** Replace both pose owners atomically; rendering borrows their pages synchronously. */
  retainPoses(...poses) {
    if (this.disposed) return;
    this.#retained = new Set(poses.filter(Boolean).map((pose) => pose.page));
    this.#releaseEvicted();
  }

  #releaseEvicted() {
    for (const page of this.#evicted) {
      if (this.#retained.has(page) || this.#loadOwns(page)) continue;
      this.#evicted.delete(page);
      releaseSpriteImage(page);
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const page of new Set([...this.pages.values(), ...this.#evicted])) releaseSpriteImage(page);
    this.loads.dispose();
    for (const [signal, owner] of this.#leased) signal.removeEventListener("abort", owner.release);
    this.#leased.clear();
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
