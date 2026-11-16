/** On-demand sprite ownership and retry control (site/docs/design/landing.md; PRD §13). */
import { SpriteAnimations } from "./sprite-animations.mjs";
import { SpritePages } from "./sprite-pages.mjs";
import { SpriteLoads } from "./sprite-loads.mjs";
import { SpriteDownloads } from "./sprite-downloads.mjs";
import { validateSpriteClip } from "./sprite-metadata.mjs";
import { SpriteDecoder } from "./sprite-decoder/index.mjs";
import { releaseSpriteImage } from "./sprite-decoder/release.mjs";
import { clipMetadataPath, clipPagePath, gameAssetUrl } from "./game-assets.mjs";
import { decodedClipBytes } from "./sprite-limits.mjs";
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
    this.downloads = new SpriteDownloads();
  }

  async load(name, options = {}) {
    options.signal?.throwIfAborted();
    if (this.disposed) throw new Error("Sprite bank is disposed.");
    if (this.clips.has(name)) return this.clips.get(name);
    const held = this.downloads.clip(name);
    if (held) return this.clips.set(name, held).get(name);
    return this.loads.run(name, this.clipPromises, async (signal) => {
      const clip = await withSpriteAssetErrorContext(clipMetadataPath(name), async () => {
        const response = await fetch(gameAssetUrl(clipMetadataPath(name)), { signal });
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
      const path = clipPagePath(name, clip.pages[index]);
      const image = await withSpriteAssetErrorContext(path, async () => {
        const held = this.downloads.sheet(path);
        if (!held) {
          const response = await fetch(gameAssetUrl(path), { signal });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return this.decoder.decode(await response.blob(), signal);
        }
        // A cancelled decode keeps the file for the next attempt; a failed one must refetch.
        try { return await this.decoder.decode(held, signal); }
        finally { if (!signal.aborted) this.downloads.release(path); }
      });
      return image;
    }, options, {
      publish: (image, pin) => { pin(image); this.resources.store(key, image); },
      discard: releaseSpriteImage,
    });
  }

  async prepare(name, options = {}) {
    options.signal?.throwIfAborted();
    // Keep the entry page pinned until preparation delivers it; then release the temporary lease.
    const preparationLease = options.signal ? null : new AbortController();
    const signal = options.signal ?? preparationLease.signal;
    this.loads.retry(name);
    try {
      const clip = await this.load(name, { signal });
      await this.loadPage(name, clip.frames[0].page, { signal });
      return clip;
    } finally { preparationLease?.abort(); }
  }

  /** Automatic preparation waits until explicit retry clears each actual failed asset. */
  hasAnimationFailure(name) {
    const dependencies = ["idle", "rotation", name];
    return [...this.loads.failed].some((key) =>
      dependencies.some((dependency) => key === dependency || key.startsWith(`${dependency}/`)),
    );
  }

  /** Resolves the complete clip, null on cancellation/teardown, or rejects an asset failure. */
  prepareAnimation(name) {
    if (this.disposed) return Promise.reject(new Error("Sprite bank is disposed."));
    return this.animations.prepare(name);
  }
  /** Transfer a ready candidate to delivered input; unmatched or pending names are no-ops. */
  publishAnimation(name) { this.animations.publish(name); }
  /** Call after prepareAnimation → publishAnimation when input is consumed.
   * currentName is playing now; nextName is the requested/next transition clip.
   */
  activateAnimation(currentName, nextName = currentName) {
    this.animations.activate(currentName, nextName);
  }
  /** Delivered input stays owned through a recovery queue until playback activation or replacement. */
  get deliveredAnimation() { return this.animations.deliveredOwner?.name; }
  /** Cancel pending/delivered preparation while active playback keeps its owner. */
  cancelPreparation() { this.animations.cancel(); }

  pinLoadPage(key, image, signal) { this.resources.pin(key, image, signal); }

  ensureMetadata(name) {
    if (!this.clips.has(name)) this.loads.request(name, (options) => this.load(name, options));
  }

  /** Decode a whole clip into the ordinary cache before anyone asks for it. `fits` receives
   * the clip's decoded size and may decline. Requests are shared and nothing stays leased.
   * A failure neither reports nor latches, so first real use makes the reported attempt.
   * Resolves the decoded size, or 0 when the clip was declined or did not load.
   */
  async loadAhead(name, fits = () => true) {
    const lease = new AbortController();
    const options = { signal: lease.signal, speculative: true };
    try {
      const clip = await this.load(name, options);
      const bytes = decodedClipBytes(clip);
      if (!fits(bytes)) return 0;
      await Promise.all([...clip.pages.keys()].map((index) => this.loadPage(name, index, options)));
      return bytes;
    } catch {
      return 0;
    } finally { lease.abort(); }
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

  /** Replace pose owners atomically: current painted pose first, outgoing blend second.
   * Rendering borrows synchronously; retain both before releasing dependency leases.
   */
  retainPoses(...poses) {
    if (this.disposed) return;
    this.resources.retainPoses(...poses);
    this.animations.releaseStaticDependencies(poses[0]);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.animations.dispose();
    this.resources.dispose();
    this.loads.dispose();
    this.downloads.close();
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
    const page = this.resources.acquirePage(key);
    if (!page) {
      this.#requestPage(name, frame.page);
      return null;
    }
    const nextPage = clip.frames[Math.min(index + 16, clip.frames.length - 1)].page;
    const nextKey = `${name}/${nextPage}`;
    if (nextPage !== frame.page && !this.pages.has(nextKey) && !this.pendingPages.has(nextKey))
      this.#requestPage(name, nextPage);
    return { clip, frame, page };
  }
}
