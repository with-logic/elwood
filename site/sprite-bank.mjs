/** On-demand sprite sheet caching and decoding (PRD §13; site/docs/design/landing.md). */
import { gameAssetUrl } from "./game-assets.mjs";
import { SpriteDecoder } from "./sprite-decoder/index.mjs";

export class SpriteBank {
  #onError;
  constructor(onError) {
    this.decoder = new SpriteDecoder();
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
      const response = await fetch(gameAssetUrl(`${name}/${clip.pages[index].file}`));
      if (!response.ok)
        throw new Error(`Couldn’t load ${name}. Check the local server and try again.`);
      const image = await this.decoder.decode(await response.blob());
      this.pages.set(key, image);
      // Only four decoded atlas pages remain resident. All other actions stay
      // compressed in the normal HTTP cache until they are needed again.
      while (this.pages.size > 4) this.pages.delete(this.pages.keys().next().value);
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

  frame(name, index) {
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
