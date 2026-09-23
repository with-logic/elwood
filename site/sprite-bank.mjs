/** On-demand sprite ownership and retry control (site/docs/design/landing.md; PRD §13). */
import { validateSpriteClip } from "./sprite-metadata.mjs";
import { gameAssetUrl } from "./game-assets.mjs";

export class SpriteBank {
  #onError;
  #automaticLoads = new Map();
  #failed = new Set();
  constructor(onError) {
    this.clips = new Map();
    this.clipPromises = new Map();
    this.pages = new Map();
    this.pendingPages = new Map();
    this.#onError = onError;
  }

  async load(name) {
    if (this.clips.has(name)) return this.clips.get(name);
    if (this.clipPromises.has(name)) return this.clipPromises.get(name);
    const promise = (async () => {
      const response = await fetch(gameAssetUrl(`${name}/clip.json`));
      if (!response.ok)
        throw new Error(`Couldn’t load ${name}. Check the local server and try again.`);
      const clip = await response.json();
      validateSpriteClip(clip, name);
      this.#failed.delete(name);
      this.clips.set(name, clip);
      return clip;
    })();
    this.clipPromises.set(name, promise);
    try {
      return await promise;
    } catch (error) {
      this.#failed.add(name);
      throw error;
    } finally {
      this.clipPromises.delete(name);
    }
  }

  async loadPage(name, index) {
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
      const image = new Image();
      image.src = gameAssetUrl(`${name}/${clip.pages[index].file}`).href;
      await image.decode();
      this.#failed.delete(key);
      this.pages.set(key, image);
      // Only four decoded atlas pages remain resident. All other actions stay
      // compressed in the normal HTTP cache until they are needed again.
      while (this.pages.size > 4) this.pages.delete(this.pages.keys().next().value);
      return image;
    })();
    this.pendingPages.set(key, promise);
    try {
      return await promise;
    } catch (error) {
      this.#failed.add(key);
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
    if (this.#automaticLoads.has(key) || this.#failed.has(key)
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

  frame(name, index) {
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
