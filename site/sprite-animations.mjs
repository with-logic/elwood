/** Own complete explicit animations until playback switches (PRD §13; docs/design/landing.md). */
import { validateSpriteClip } from "./sprite-metadata.mjs";
import { gameAssetUrl } from "./game-assets.mjs";
import { SpriteDecoder } from "./sprite-decoder/index.mjs";

export class SpriteAnimations {
  constructor(bank) {
    this.bank = bank;
    this.activeOwner = null;
    this.deliveredOwner = null;
    this.candidateOwner = null;
  }

  prepares(key) {
    return !!this.candidateOwner && ["idle", "rotation", this.candidateOwner.name].includes(key.split("/")[0]);
  }

  owns(image) {
    return [this.activeOwner, this.deliveredOwner, this.candidateOwner].some((owner) => owner && [...owner.pages.values()].includes(image));
  }

  page(key) {
    return this.activeOwner?.pages.get(key)
      ?? this.deliveredOwner?.pages.get(key)
      ?? (this.candidateOwner?.ready ? this.candidateOwner.pages.get(key) : undefined);
  }

  release(owner) {
    if (!owner) return;
    owner.controller.abort();
    owner.decoder.dispose();
    for (const image of owner.pages.values()) this.bank.releaseAnimationPage(image);
  }

  cancel() {
    const old = this.candidateOwner;
    this.candidateOwner = null;
    this.release(old);
    const delivered = this.deliveredOwner;
    this.deliveredOwner = null;
    this.release(delivered);
  }

  publish(name) {
    if (this.candidateOwner?.ready && this.candidateOwner.name === name) {
      const old = this.deliveredOwner;
      this.deliveredOwner = this.candidateOwner;
      this.candidateOwner = null;
      this.release(old);
    }
  }

  activate(name) {
    if (this.deliveredOwner?.name === name) {
      const old = this.activeOwner;
      this.activeOwner = this.deliveredOwner;
      this.deliveredOwner = null;
      this.release(old);
    } else if (this.activeOwner && !this.activeOwner.clips.has(name)) {
      const old = this.activeOwner;
      this.activeOwner = null;
      this.release(old);
    }
  }

  async prepare(name) {
    this.cancel();
    if (this.activeOwner?.name === name) return this.activeOwner.clips.get(name);
    const owner = {
      name, controller: new AbortController(), decoder: new SpriteDecoder(),
      pages: new Map(), clips: new Map(), ready: false,
    };
    this.candidateOwner = owner;
    for (const clipName of new Set(["idle", "rotation", name])) this.bank.loads.claimClip(clipName);
    const { signal } = owner.controller;
    const fetchAsset = async (path) => {
      const response = await fetch(gameAssetUrl(path), { signal });
      if (!response.ok) throw new Error(`Couldn’t load ${path}. Check the local server and try again.`);
      return response;
    };
    try {
      for (const clipName of new Set(["idle", "rotation", name])) {
        const clip = this.bank.clips.get(clipName)
          ?? await (await fetchAsset(`${clipName}/clip.json`)).json();
        signal.throwIfAborted();
        validateSpriteClip(clip, clipName);
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
      for (const [clipName, clip] of owner.clips) {
        this.bank.clips.set(clipName, clip);
        this.bank.loads.accept(clipName);
      }
      for (const key of owner.pages.keys()) this.bank.loads.accept(key);
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
    const old = this.activeOwner;
    this.activeOwner = null;
    this.release(old);
  }
}
