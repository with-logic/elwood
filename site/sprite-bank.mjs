/** Active and prepared sprite ownership for continuous motion (docs/design/landing.md). */
import { gameAssetUrl } from "./game-assets.mjs";
import { SpriteSources, parseSpriteClip, shareSpriteRequest, spriteSheetContext } from "./sprite-sources.mjs";

export class SpriteBank {
  #onError;
  constructor(onError) {
    this.sources = new SpriteSources();
    this.activeName = null;
    this.activePages = new Map();
    this.supportPages = new Map(); // idle and rotation remain available across gesture transitions
    this.prepared = null;
    this.preparationGeneration = 0;
    this.preparationAbort = null;
    this.preparationTail = Promise.resolve();
    this.decodeTail = Promise.resolve();
    this.clips = new Map();
    this.pages = new Map();
    this.pendingPages = new Map();
    this.#onError = onError;
  }

  async load(name, signal) {
    if (this.clips.has(name)) return this.clips.get(name);
    const url = gameAssetUrl(`${name}/clip.json`);
    const blob = await this.sources.load(url, signal, "metadata");
    const clip = await parseSpriteClip(blob, url);
    signal?.throwIfAborted();
    this.clips.set(name, clip);
    return clip;
  }

  async loadPage(name, index, downloaded, signal) {
    const key = `${name}/${index}`;
    const retained = this.retainedPage(key);
    if (retained) return retained;
    if (this.pages.has(key)) {
      const page = this.pages.get(key);
      this.pages.delete(key);
      this.pages.set(key, page);
      return page;
    }
    // Network work overlaps across pages; only browser decodes take the serial slot.
    return shareSpriteRequest(this.pendingPages, key, async (owned) => {
      const clip = await this.load(name, owned);
      const sheet = gameAssetUrl(`${name}/${clip.pages[index].file}`);
      let blob = downloaded ?? await this.sources.load(sheet, owned);
      downloaded = undefined;
      owned.throwIfAborted();
      const release = () => { blob = undefined; };
      owned.addEventListener("abort", release, { once: true });
      const decode = this.decodeTail.catch(() => {}).then(async () => {
        owned.removeEventListener("abort", release);
        owned.throwIfAborted();
        const image = new Image();
        const url = URL.createObjectURL(blob);
        release();
        try {
          image.src = url;
          await image.decode();
        } catch (cause) {
          throw new Error(`Couldn’t decode animation sheet ${spriteSheetContext(sheet)}. Try again.`, { cause });
        } finally {
          URL.revokeObjectURL(url);
        }
        owned.throwIfAborted();
        if (this.activeName === name) this.activePages.set(key, image);
        if (name === "idle" || name === "rotation") this.supportPages.set(key, image);
        this.pages.set(key, image);
        // Four opportunistic sheets supplement the active clip, transitions and candidate.
        while (this.pages.size > 4) this.pages.delete(this.pages.keys().next().value);
        return image;
      });
      this.decodeTail = decode;
      return decode;
    }, signal);
  }

  retainedPage(key) {
    return this.activePages.get(key) ?? this.supportPages.get(key)
      ?? (this.prepared?.current() ? this.prepared.pages.get(key) : undefined);
  }

  cancelPreparation() {
    this.preparationGeneration++;
    this.preparationAbort?.abort();
    this.prepared = null;
  }

  animationReady(name) {
    const clip = this.clips.get(name);
    return !!clip && clip.pages.every((_page, index) => this.retainedPage(`${name}/${index}`));
  }

  prepareAnimation(name, isCurrent = () => true) {
    this.cancelPreparation();
    const generation = this.preparationGeneration;
    const controller = new AbortController();
    this.preparationAbort = controller;
    const current = () => generation === this.preparationGeneration && isCurrent();
    // Coalesce same-turn requests without waiting for stale downloads. Cancellation
    // releases source consumers; a browser decode may finish under the shared decode gate.
    const promise = Promise.resolve().then(async () => {
      if (!current()) return;
      const names = [...new Set(name === "idle" ? [name] : ["idle", "rotation", name])];
      const clips = await Promise.all(names.map((clipName) => this.load(clipName, controller.signal)));
      if (!current()) return;
      const pages = new Map();
      const decoding = [];
      for (const [position, clipName] of names.entries()) {
        for (let index = 0; index < clips[position].pages.length; index++) {
          const key = `${clipName}/${index}`;
          // Each transfer feeds the serial decoder directly: no result array keeps
          // compressed bytes alive after decoding. Promise.all consumes late errors.
          decoding.push(this.loadPage(clipName, index, undefined, controller.signal)
            .then((image) => { if (current()) pages.set(key, image); }));
        }
      }
      await Promise.all(decoding);
      if (!current()) return;
      this.prepared = { name, pages, current };
      return this.clips.get(name);
    }).catch((error) => {
      controller.abort();
      if (current()) throw error;
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
      if (!this.pendingPages.has(key)) this.loadPage(name, frame.page).catch(this.#onError);
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
