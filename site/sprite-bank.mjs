/** Owns cached and pose-retained sprite resources (PRD §13; docs/design/landing.md). */
import { gameAssetUrl } from "./game-assets.mjs";

function releasePage(page) {
  if (typeof page.close === "function") page.close();
  else page.removeAttribute?.("src");
}

export class SpriteBank {
  #onError;
  #retained = new Set();
  #evicted = new Set();
  constructor(onError) {
    this.clips = new Map();
    this.clipPromises = new Map();
    this.pages = new Map();
    this.pendingPages = new Map();
    this.disposed = false;
    this.#onError = (error) => {
      if (!this.disposed) onError(error);
    };
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
      this.clips.set(name, clip);
      return clip;
    })();
    this.clipPromises.set(name, promise);
    try {
      return await promise;
    } finally {
      this.clipPromises.delete(name);
    }
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
      const image = new Image();
      let cached = false;
      try {
        image.src = gameAssetUrl(`${name}/${clip.pages[index].file}`).href;
        await image.decode();
        if (this.disposed) throw new Error("Sprite bank is disposed.");
        this.pages.set(key, image);
        cached = true;
      } finally {
        if (!cached) releasePage(image);
      }
      // Evicted pages may still belong to the current or outgoing pose.
      while (this.pages.size > 4) {
        const oldest = this.pages.keys().next().value;
        const evicted = this.pages.get(oldest);
        this.pages.delete(oldest);
        if (this.#retained.has(evicted)) this.#evicted.add(evicted);
        else releasePage(evicted);
      }
      return image;
    })();
    this.pendingPages.set(key, promise);
    try {
      return await promise;
    } finally {
      this.pendingPages.delete(key);
    }
  }

  async prepare(name) {
    const clip = await this.load(name);
    await this.loadPage(name, clip.frames[0].page);
    return clip;
  }

  /** Replace both pose owners atomically; rendering borrows their pages synchronously. */
  retainPoses(...poses) {
    if (this.disposed) return;
    this.#retained = new Set(poses.filter(Boolean).map((pose) => pose.page));
    for (const page of this.#evicted) {
      if (this.#retained.has(page)) continue;
      this.#evicted.delete(page);
      releasePage(page);
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const page of new Set([...this.pages.values(), ...this.#evicted])) releasePage(page);
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
      this.prepare(name).catch(this.#onError);
      return null;
    }
    const frame = clip.frames[Math.min(index, clip.frames.length - 1)];
    const key = `${name}/${frame.page}`;
    const page = this.pages.get(key);
    if (!page) {
      this.loadPage(name, frame.page).catch(this.#onError);
      return null;
    }
    this.pages.delete(key);
    this.pages.set(key, page);
    const nextPage = clip.frames[Math.min(index + 16, clip.frames.length - 1)].page;
    const nextKey = `${name}/${nextPage}`;
    if (nextPage !== frame.page && !this.pages.has(nextKey) && !this.pendingPages.has(nextKey))
      this.loadPage(name, nextPage).catch(this.#onError);
    return { clip, frame, page };
  }
}
