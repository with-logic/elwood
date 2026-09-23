/** Own complete explicit animations until playback switches (PRD §13; docs/design/landing.md). */
import { gameAssetUrl } from "./game-assets.mjs";
import { SpriteDecoder } from "./sprite-decoder/index.mjs";

export class SpriteAnimations {
  constructor(bank) {
    this.bank = bank;
    this.active = null;
    this.delivered = null;
    this.candidate = null;
  }

  owns(image) {
    return [this.active, this.delivered, this.candidate].some((owner) => owner && [...owner.pages.values()].includes(image));
  }

  page(key) {
    return this.active?.pages.get(key)
      ?? this.delivered?.pages.get(key)
      ?? (this.candidate?.ready ? this.candidate.pages.get(key) : undefined);
  }

  release(owner) {
    if (!owner) return;
    owner.controller.abort();
    owner.decoder.dispose();
    for (const image of owner.pages.values()) this.bank.releaseAnimationPage(image);
  }

  cancel() {
    const old = this.candidate;
    this.candidate = null;
    this.release(old);
  }

  publish(name) {
    if (this.candidate?.ready && this.candidate.name === name) {
      const old = this.delivered;
      this.delivered = this.candidate;
      this.candidate = null;
      this.release(old);
    }
  }

  activate(name) {
    if (this.delivered?.name === name) {
      const old = this.active;
      this.active = this.delivered;
      this.delivered = null;
      this.release(old);
    } else if (this.active && !this.active.clips.has(name)) {
      const old = this.active;
      this.active = null;
      this.release(old);
    }
  }

  async prepare(name) {
    this.cancel();
    if (this.active?.name === name) return this.active.clips.get(name);
    const owner = {
      name, controller: new AbortController(), decoder: new SpriteDecoder(),
      pages: new Map(), clips: new Map(), ready: false,
    };
    this.candidate = owner;
    const { signal } = owner.controller;
    const fetchAsset = async (path) => {
      const response = await fetch(gameAssetUrl(path), { signal });
      if (!response.ok) throw new Error(`Couldn’t load ${name}. Check the local server and try again.`);
      return response;
    };
    try {
      for (const clipName of new Set(["idle", "rotation", name])) {
        const clip = this.bank.clips.get(clipName)
          ?? await (await fetchAsset(`${clipName}/clip.json`)).json();
        signal.throwIfAborted();
        owner.clips.set(clipName, clip);
        for (const [index, page] of clip.pages.entries()) {
          signal.throwIfAborted();
          const key = `${clipName}/${index}`;
          let image = this.page(key) ?? this.bank.pages.get(key);
          if (!image) {
            const blob = await (await fetchAsset(`${clipName}/${page.file}`)).blob();
            signal.throwIfAborted();
            image = await owner.decoder.decode(blob);
            if (signal.aborted) {
              this.bank.releaseAnimationPage(image);
              signal.throwIfAborted();
            }
          }
          owner.pages.set(key, image);
        }
      }
      signal.throwIfAborted();
      owner.ready = true;
      for (const [clipName, clip] of owner.clips) this.bank.clips.set(clipName, clip);
      owner.decoder.dispose();
      return owner.clips.get(name);
    } catch (error) {
      if (signal.aborted) return null;
      this.cancel();
      throw error;
    }
  }

  dispose() {
    this.cancel();
    const delivered = this.delivered;
    this.delivered = null;
    this.release(delivered);
    const old = this.active;
    this.active = null;
    this.release(old);
  }
}
