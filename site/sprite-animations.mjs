/** Own complete explicit animations until playback switches (PRD §13; docs/design/landing.md). */

export class SpriteAnimations {
  constructor(bank) {
    this.bank = bank;
    this.activeOwner = null;
    this.deliveredOwner = null;
    this.candidateOwner = null;
  }

  page(key) {
    return this.activeOwner?.pages.get(key)
      ?? this.deliveredOwner?.pages.get(key)
      ?? (this.candidateOwner?.ready ? this.candidateOwner.pages.get(key) : undefined);
  }

  release(owner) {
    if (!owner) return;
    owner.controller.abort();
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
      name, controller: new AbortController(),
      pages: new Map(), clips: new Map(), ready: false,
    };
    this.candidateOwner = owner;
    for (const clipName of new Set(["idle", "rotation", name])) this.bank.loads.retry(clipName);
    const { signal } = owner.controller;
    try {
      for (const clipName of new Set(["idle", "rotation", name])) {
        const clip = await this.bank.load(clipName, { signal });
        signal.throwIfAborted();
        owner.clips.set(clipName, clip);
        for (const index of clip.pages.keys()) {
          const image = await this.bank.loadPage(clipName, index, { signal });
          signal.throwIfAborted();
          owner.pages.set(`${clipName}/${index}`, image);
        }
      }
      signal.throwIfAborted();
      owner.ready = true;
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
