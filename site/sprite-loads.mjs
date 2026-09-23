/** Coalesce automatic asset requests and latch failures until explicit retry (PRD §13). */
export class SpriteLoads {
  constructor(bank, onError) {
    this.bank = bank;
    this.onError = onError;
    this.failed = new Set();
    this.automatic = new Map();
    this.inflight = new Map();
  }
  claim(key) {
    const owner = this.automatic.get(key);
    if (owner) owner.explicit = true;
  }
  retry(name) {
    for (const key of this.failed)
      if (key === name || key.startsWith(`${name}/`)) this.failed.delete(key);
    this.claim(name);
  }
  claimClip(name) {
    this.retry(name);
    for (const key of this.automatic.keys())
      if (key.startsWith(`${name}/`)) this.claim(key);
  }
  accept(key) {
    this.failed.delete(key);
    const attempt = this.inflight.get(key);
    if (attempt) attempt.superseded = true;
    this.claim(key);
  }
  track(key, promise, pending) {
    const attempt = { superseded: false };
    this.inflight.set(key, attempt);
    const settled = promise.catch((error) => {
      if (!this.bank.disposed && !attempt.superseded) this.failed.add(key);
      throw error;
    }).finally(() => {
      pending.delete(key);
      this.inflight.delete(key);
    });
    pending.set(key, settled);
    return settled;
  }
  request(key, load) {
    const bank = this.bank;
    if (bank.disposed || this.automatic.has(key) || this.failed.has(key)
      || bank.clipPromises.has(key) || bank.pendingPages.has(key)) return;
    const owner = { explicit: bank.animations.prepares(key) };
    this.automatic.set(key, owner);
    load().catch((error) => {
      if (!bank.disposed && !owner.explicit) this.onError(error);
    }).finally(() => this.automatic.delete(key));
  }
  dispose() {
    this.failed.clear();
    this.automatic.clear();
    this.inflight.clear();
  }
}
