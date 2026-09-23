/** On-demand sprite ownership and retry control (site/docs/design/landing.md; PRD §13). */
import { validateSpriteClip } from "./sprite-metadata.mjs";
import { gameAssetUrl } from "./game-assets.mjs";

function releasePage(page) {
  if (typeof page.close === "function") page.close();
  else page.removeAttribute?.("src");
}

export class SpriteBank {
  #onError;
  #retained = new Set();
  #evicted = new Set();
  #automaticLoads = new Map();
  #failed = new Set();
  constructor(onError) {
    this.clips = new Map();
    this.clipPromises = new Map();
    this.pages = new Map();
    this.pendingPages = new Map();
    this.disposed = false;
    this.#onError = (error) => { if (!this.disposed) onError(error); };
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
      this.#failed.delete(name);
      this.clips.set(name, clip);
      return clip;
    })();
    this.clipPromises.set(name, promise);
    try {
      return await promise;
    } catch (error) {
      if (!this.disposed) this.#failed.add(name);
      throw error;
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
        this.#failed.delete(key);
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
    } catch (error) {
      if (!this.disposed) this.#failed.add(key);
      throw error;
    } finally {
      this.pendingPages.delete(key);
    }
  }

  async prepare(name) {
    for (const key of this.#failed)
      if (key === name || key.startsWith(`${name}/`)) this.#failed.delete(key);
    this.#claimAutomaticLoad(name);
    const clip = await this.load(name);
    this.#claimAutomaticLoad(`${name}/${clip.frames[0].page}`);
    await this.loadPage(name, clip.frames[0].page);
    return clip;
  }

  #claimAutomaticLoad(key) {
    const owner = this.#automaticLoads.get(key);
    if (owner) owner.explicit = true;
  }

  #requestAutomaticLoad(key, load) {
    if (this.disposed || this.#automaticLoads.has(key) || this.#failed.has(key)
      || this.clipPromises.has(key) || this.pendingPages.has(key)) return;
    const owner = { explicit: false };
    this.#automaticLoads.set(key, owner);
    load().catch((error) => {
      if (!owner.explicit) this.#onError(error);
    }).finally(() => this.#automaticLoads.delete(key));
  }

  ensureMetadata(name) {
    if (!this.clips.has(name)) this.#requestAutomaticLoad(name, () => this.load(name));
  }

  #requestPage(name, index) {
    const key = `${name}/${index}`;
    if (!this.pages.has(key)) this.#requestAutomaticLoad(key, () => this.loadPage(name, index));
  }

  ensureEntryPage(name) {
    const clip = this.clips.get(name);
    if (!clip) {
      this.#requestAutomaticLoad(name, () => this.load(name).then((loaded) => {
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
    this.#automaticLoads.clear();
    this.#failed.clear();
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
