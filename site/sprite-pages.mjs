/** Bound cache, load-lease and pose ownership of decoded pages (PRD §13; docs/design/landing.md). */
import { releaseSpriteImage } from "./sprite-decoder/release.mjs";

export class SpritePages {
  #retained = new Set();
  #evicted = new Set();
  #leased = new Map();
  constructor() { this.cached = new Map(); }

  acquirePage(key, signal) {
    const image = this.cached.get(key)
      ?? [...this.#leased.values()].map((owner) => owner.pages.get(key)).find(Boolean);
    if (!image) return undefined;
    if (signal) this.pin(key, image, signal);
    this.store(key, image);
    return image;
  }

  store(key, image) {
    this.#evicted.delete(image);
    this.cached.delete(key);
    this.cached.set(key, image);
    while (this.cached.size > 4) {
      const oldest = this.cached.keys().next().value;
      const evicted = this.cached.get(oldest);
      this.cached.delete(oldest);
      if (this.#owns(evicted)) this.#evicted.add(evicted);
      else releaseSpriteImage(evicted);
    }
  }

  pin(key, image, signal) {
    let owner = this.#leased.get(signal);
    if (!owner) {
      owner = { pages: new Map(), release: () => {
        this.#leased.delete(signal);
        this.#releaseEvicted();
      } };
      this.#leased.set(signal, owner);
      signal.addEventListener("abort", owner.release, { once: true });
    }
    owner.pages.set(key, image);
  }

  #owns(image) {
    return this.#retained.has(image)
      || [...this.#leased.values()].some((owner) => [...owner.pages.values()].includes(image));
  }

  retainPoses(...poses) {
    this.#retained = new Set(poses.filter(Boolean).map((pose) => pose.page));
    this.#releaseEvicted();
  }

  #releaseEvicted() {
    for (const page of this.#evicted) {
      if (this.#owns(page)) continue;
      this.#evicted.delete(page);
      releaseSpriteImage(page);
    }
  }

  dispose() {
    for (const page of new Set([...this.cached.values(), ...this.#evicted])) releaseSpriteImage(page);
    for (const [signal, owner] of this.#leased) signal.removeEventListener("abort", owner.release);
    this.#leased.clear();
    this.cached.clear();
    this.#retained.clear();
    this.#evicted.clear();
  }
}
