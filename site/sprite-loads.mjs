/** Coalesce automatic asset requests and latch failures until explicit retry (PRD §13). */
export class SpriteLoads {
  constructor(bank, onError) {
    this.bank = bank;
    this.onError = onError;
    this.failed = new Set();
    this.automatic = new Map();
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
  request(key, load) {
    const bank = this.bank;
    if (bank.disposed || this.automatic.has(key) || this.failed.has(key)
      || bank.clipPromises.has(key) || bank.pendingPages.has(key)) return;
    const owner = { explicit: false };
    this.automatic.set(key, owner);
    load().catch((error) => {
      if (!bank.disposed && !owner.explicit) this.onError(error);
    }).finally(() => this.automatic.delete(key));
  }
  dispose() {
    this.failed.clear();
    this.automatic.clear();
  }
}
