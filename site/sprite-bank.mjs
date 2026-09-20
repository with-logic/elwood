import { gameAssetUrl } from "./game-assets.mjs";
import { SpriteSources } from "./sprite-sources.mjs";

export class SpriteBank {
  #onError;
  constructor(onError) {
    this.sources = new SpriteSources();
    this.playback = new Map();
    this.playbackVersion = 0;
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
    if (this.playback.has(key)) return this.playback.get(key);
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
      const blob = await this.sources.load(gameAssetUrl(`${name}/${clip.pages[index].file}`));
      const url = URL.createObjectURL(blob);
      try {
        image.src = url;
        await image.decode();
      } finally {
        URL.revokeObjectURL(url);
      }
      this.pages.set(key, image);
      // Keep only four decoded sheets; compressed sources have a separate byte budget.
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

  async preload(name) {
    const clip = await this.load(name);
    await Promise.all(
      clip.pages.map((page) => this.sources.load(gameAssetUrl(`${name}/${page.file}`))),
    );
  }

  animationReady(name) {
    const clip = this.clips.get(name);
    return !!clip && clip.pages.every((_page, index) => this.playback.has(`${name}/${index}`));
  }

  async prepareAnimation(name) {
    const version = ++this.playbackVersion;
    const clip = await this.load(name);
    const pages = await Promise.all(clip.pages.map((_page, index) => this.loadPage(name, index)));
    // Keep the current clip drawable while its replacement downloads and decodes.
    // A slower, superseded request must not evict the newer playback's images.
    if (version === this.playbackVersion)
      this.playback = new Map(pages.map((page, index) => [`${name}/${index}`, page]));
    return clip;
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
    const page = this.playback.get(key) ?? this.pages.get(key);
    if (!page) {
      this.loadPage(name, frame.page).catch(this.#onError);
      return null;
    }
    if (!this.playback.has(key)) {
      this.pages.delete(key);
      this.pages.set(key, page);
    }
    const nextPage = clip.frames[Math.min(index + 16, clip.frames.length - 1)].page;
    const nextKey = `${name}/${nextPage}`;
    if (nextPage !== frame.page && !this.playback.has(nextKey)
      && !this.pages.has(nextKey) && !this.pendingPages.has(nextKey))
      this.loadPage(name, nextPage).catch(this.#onError);
    return { clip, frame, page };
  }
}
