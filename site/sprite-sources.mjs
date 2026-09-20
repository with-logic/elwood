/** Deduplicate in-flight sheets while preserving asset revalidation (docs/design/landing.md). */
export class SpriteSources {
  constructor() {
    this.pending = new Map();
  }

  async load(url) {
    const key = String(url);
    if (this.pending.has(key)) return this.pending.get(key);
    const promise = (async () => {
      let status;
      try {
        const response = await fetch(url, { cache: "no-cache" });
        if (!response.ok) {
          status = response.status;
          throw new Error(`HTTP ${status}`);
        }
        return await response.blob();
      } catch (cause) {
        const path = new URL(key, "https://assets.invalid/").pathname;
        const sheet = path.split("/").slice(-2).join("/")
          .replace(/[^a-zA-Z0-9_./-]/g, "?").slice(0, 160);
        const reason = status === undefined ? "" : ` (HTTP ${status})`;
        throw new Error(`Couldn’t load animation sheet ${sheet}${reason}. Try again.`, { cause });
      }
    })();
    this.pending.set(key, promise);
    try {
      return await promise;
    } finally {
      this.pending.delete(key);
    }
  }
}
