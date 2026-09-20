/** Share in-flight asset downloads without retaining superseded consumers (docs/design/landing.md). */
export function spriteSheetContext(url) {
  return new URL(String(url), "https://assets.invalid/").pathname.split("/").slice(-2).join("/")
    .replace(/[^a-zA-Z0-9_./-]/g, "?").slice(0, 160);
}

/** A sprite fetch/decode survives cancellation only while a live consumer still owns it. */
export function shareSpriteRequest(pending, key, start, signal) {
  signal?.throwIfAborted();
  let entry = pending.get(key);
  if (!entry) {
    entry = { controller: new AbortController(), consumers: 0 };
    entry.promise = start(entry.controller.signal).finally(() => {
      if (pending.get(key) === entry) pending.delete(key);
    });
    pending.set(key, entry);
  }
  entry.consumers++;
  return new Promise((resolve, reject) => {
    const abort = () => finish(reject, signal.reason);
    let settled = false;
    const finish = (settle, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      if (--entry.consumers === 0) {
        if (pending.get(key) === entry) pending.delete(key);
        entry.controller.abort();
      }
      settle(value);
    };
    signal?.addEventListener("abort", abort, { once: true });
    entry.promise.then((value) => finish(resolve, value), (error) => finish(reject, error));
  });
}

export class SpriteSources {
  constructor() {
    this.pending = new Map();
  }

  async load(url, signal) {
    return shareSpriteRequest(this.pending, String(url), (owned) => this.download(url, owned), signal);
  }

  async download(url, signal) {
    let status;
    try {
      const response = await fetch(url, { cache: "no-cache", signal });
      if (!response.ok) {
        status = response.status;
        throw new Error(`HTTP ${status}`);
      }
      return await response.blob();
    } catch (cause) {
      const reason = status === undefined ? "" : ` (HTTP ${status})`;
      throw new Error(`Couldn’t load animation sheet ${spriteSheetContext(url)}${reason}. Try again.`, { cause });
    }
  }
}
