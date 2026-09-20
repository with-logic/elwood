/** Bounded compressed sprite cache for continuous playback (docs/design/landing.md). */
export class SpriteSources {
  constructor(maxBytes = 32 * 1024 * 1024) {
    this.maxBytes = maxBytes;
    this.bytes = 0;
    this.cached = new Map();
    this.pending = new Map();
  }

  has(url) {
    return this.cached.has(String(url));
  }

  async load(url) {
    const key = String(url);
    if (this.has(key)) {
      const blob = this.cached.get(key);
      this.cached.delete(key);
      this.cached.set(key, blob);
      return blob;
    }
    if (this.pending.has(key)) return this.pending.get(key);
    const promise = (async () => {
      const response = await fetch(url);
      if (!response.ok) throw new Error("Couldn’t load an animation sheet. Try again.");
      const blob = await response.blob();
      if (blob.size <= this.maxBytes) {
        this.cached.set(key, blob);
        this.bytes += blob.size;
        while (this.bytes > this.maxBytes) {
          const oldest = this.cached.keys().next().value;
          this.bytes -= this.cached.get(oldest).size;
          this.cached.delete(oldest);
        }
      }
      return blob;
    })();
    this.pending.set(key, promise);
    try {
      return await promise;
    } finally {
      this.pending.delete(key);
    }
  }
}
