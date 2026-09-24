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

  /** Publish only a ready matching candidate; mismatches preserve every owner. */
  publish(name) {
    if (this.candidateOwner?.ready && this.candidateOwner.name === name) {
      const old = this.deliveredOwner;
      this.deliveredOwner = this.candidateOwner;
      this.candidateOwner = null;
      this.release(old);
    }
  }

  /** Activate a delivered request before cancellation can drop it. Opening turns pass their target. */
  activate(name, target = name) {
    if (this.deliveredOwner?.name === target) {
      const old = this.activeOwner;
      this.activeOwner = this.deliveredOwner;
      this.deliveredOwner = null;
      this.release(old);
    }
    const owner = this.activeOwner;
    if (!owner || name === owner.name || target === owner.name) return;
    // Playback has left the requested clip. Keep only the current/next dependency;
    // SpritePages independently protects the rendered current and outgoing poses.
    for (const clipName of owner.clips.keys()) {
      if (clipName === name || clipName === target) continue;
      owner.leases.get(clipName).abort();
      owner.leases.delete(clipName);
      owner.clips.delete(clipName);
      for (const key of owner.pages.keys()) if (key.startsWith(`${clipName}/`)) owner.pages.delete(key);
    }
    if (!owner.clips.size) {
      this.activeOwner = null;
      this.release(owner);
    }
  }

  async prepare(name) {
    this.cancel();
    if (this.activeOwner?.name === name && this.activeOwner.clips.has(name))
      return this.activeOwner.clips.get(name);
    const owner = {
      name, controller: new AbortController(),
      pages: new Map(), clips: new Map(), leases: new Map(), ready: false,
    };
    this.candidateOwner = owner;
    const names = [...new Set(["idle", "rotation", name])];
    for (const clipName of names) {
      this.bank.loads.retry(clipName);
      owner.leases.set(clipName, new AbortController());
    }
    const { signal } = owner.controller;
    signal.addEventListener("abort", () => {
      for (const lease of owner.leases.values()) lease.abort();
    }, { once: true });
    try {
      // Metadata is bounded by the three requested/dependency clips. Fetch up to
      // four pages concurrently; SpriteDecoder still serializes worker decoding.
      await Promise.all(names.map(async (clipName) => {
        const clip = await this.bank.load(clipName, { signal: owner.leases.get(clipName).signal });
        signal.throwIfAborted();
        owner.clips.set(clipName, clip);
      }));
      const pages = names.flatMap((clipName) => [...owner.clips.get(clipName).pages.keys()]
        .map((index) => ({ clipName, index })));
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(4, pages.length) }, async () => {
        while (next < pages.length) {
          signal.throwIfAborted();
          const { clipName, index } = pages[next++];
          const image = await this.bank.loadPage(clipName, index, {
            signal: owner.leases.get(clipName).signal,
          });
          signal.throwIfAborted();
          owner.pages.set(`${clipName}/${index}`, image);
        }
      }));
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
