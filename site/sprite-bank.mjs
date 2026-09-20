/** Active and prepared sprite ownership for continuous motion (docs/design/landing.md). */
import { gameAssetUrl } from "./game-assets.mjs";
import { SpriteSources } from "./sprite-sources.mjs";

export class SpriteBank {
  #onError;
  constructor(onError) {
    this.sources = new SpriteSources();
    this.activeName = null;
    this.activePages = new Map();
    this.supportPages = new Map(); // idle and rotation remain available across gesture transitions
    this.prepared = null;
    this.preparationGeneration = 0;
    this.preparationTail = Promise.resolve();
    this.decodeTail = Promise.resolve();
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

  async loadPage(name, index, downloaded) {
    const key = `${name}/${index}`;
    const retained = this.retainedPage(key);
    if (retained) return retained;
    if (this.pages.has(key)) {
      const page = this.pages.get(key);
      this.pages.delete(key);
      this.pages.set(key, page);
      return page;
    }
    if (this.pendingPages.has(key)) return this.pendingPages.get(key);
    const promise = this.decodeTail.catch(() => {}).then(async () => {
      const clip = await this.load(name);
      const image = new Image();
      const blob = downloaded ?? await this.sources.load(gameAssetUrl(`${name}/${clip.pages[index].file}`));
      const url = URL.createObjectURL(blob);
      try {
        image.src = url;
        await image.decode();
      } finally {
        URL.revokeObjectURL(url);
      }
      if (this.activeName === name) this.activePages.set(key, image);
      if (name === "idle" || name === "rotation") this.supportPages.set(key, image);
      this.pages.set(key, image);
      // Four opportunistic sheets supplement the active clip, transitions and candidate.
      while (this.pages.size > 4) this.pages.delete(this.pages.keys().next().value);
      return image;
    });
    this.decodeTail = promise;
    this.pendingPages.set(key, promise);
    try {
      return await promise;
    } finally {
      this.pendingPages.delete(key);
    }
  }

  retainedPage(key) {
    return this.activePages.get(key) ?? this.supportPages.get(key)
      ?? (this.prepared?.current() ? this.prepared.pages.get(key) : undefined);
  }

  cancelPreparation() {
    this.preparationGeneration++;
    this.prepared = null;
  }

  animationReady(name) {
    const clip = this.clips.get(name);
    return !!clip && clip.pages.every((_page, index) => this.retainedPage(`${name}/${index}`));
  }

  prepareAnimation(name, isCurrent = () => true) {
    this.cancelPreparation();
    const generation = this.preparationGeneration;
    const current = () => generation === this.preparationGeneration && isCurrent();
    // One preparation owns decoded candidates. Superseded queued work does no I/O;
    // an in-flight decode may finish, but cannot retain or publish its candidate.
    const promise = this.preparationTail.catch(() => {}).then(async () => {
      if (!current()) return;
      const names = [...new Set(name === "idle" ? [name] : ["idle", "rotation", name])];
      const clips = await Promise.all(names.map((clipName) => this.load(clipName)));
      if (!current()) return;
      const downloads = [];
      for (const [position, clipName] of names.entries()) {
        const clip = clips[position];
        for (let index = 0; index < clip.pages.length; index++) {
          const key = `${clipName}/${index}`;
          const page = this.retainedPage(key) ?? this.pages.get(key);
          const source = page ? Promise.resolve(null)
            : this.sources.load(gameAssetUrl(`${clipName}/${clip.pages[index].file}`));
          downloads.push(source.then((blob) => ({ key, clipName, index, page, blob })));
        }
      }
      // Download one candidate in parallel; settle every source before another
      // preparation takes over, including after a failure. Decode only live work.
      const results = await Promise.allSettled(downloads);
      if (!current()) return;
      const pages = new Map();
      for (const result of results) {
        if (result.status === "rejected") throw result.reason;
        const { key, clipName, index, page, blob } = result.value;
        const image = page ?? await this.loadPage(clipName, index, blob);
        if (!current()) return;
        pages.set(key, image);
      }
      this.prepared = { name, pages, current };
      return this.clips.get(name);
    });
    this.preparationTail = promise;
    return promise;
  }

  /** Called only when the scene actually displays this clip, never by preparation completion. */
  activate(name) {
    if (name === this.activeName) return;
    const candidate = this.prepared?.current() ? this.prepared : null;
    const pages = new Map([...this.pages, ...this.supportPages, ...(candidate?.pages ?? [])]
      .filter(([key]) => key.startsWith(`${name}/`)));
    if (!pages.size) return;
    this.activeName = name;
    this.activePages = pages;
    if (candidate?.name === name) this.prepared = null;
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
    const page = this.retainedPage(key) ?? this.pages.get(key);
    if (!page) {
      this.loadPage(name, frame.page).catch(this.#onError);
      return null;
    }
    if (!this.retainedPage(key)) {
      this.pages.delete(key);
      this.pages.set(key, page);
    }
    const nextPage = clip.frames[Math.min(index + 16, clip.frames.length - 1)].page;
    const nextKey = `${name}/${nextPage}`;
    if (nextPage !== frame.page && !this.retainedPage(nextKey)
      && !this.pages.has(nextKey) && !this.pendingPages.has(nextKey))
      this.loadPage(name, nextPage).catch(this.#onError);
    return { clip, frame, page };
  }
}
