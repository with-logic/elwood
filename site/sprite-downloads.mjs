/** Sprite files downloaded ahead of use and held until first use, which then needs no request (PRD §13.5). */
import { clipMetadataPath, clipPagePath, gameAssetUrl } from "./game-assets.mjs";
import { validateSpriteClip } from "./sprite-metadata.mjs";

/** Every WebP file starts "RIFF", four length bytes, then "WEBP". */
async function isWebp(blob) {
  const head = String.fromCharCode(...new Uint8Array(await blob.slice(0, 12).arrayBuffer()));
  return head.length === 12 && head.startsWith("RIFF") && head.endsWith("WEBP");
}

export class SpriteDownloads {
  #clips = new Map();
  #sheets = new Map();
  #closed = false;

  /** Download a clip's metadata and sheets at low priority, one request at a time, so a clip
   * the visitor asks for meanwhile keeps the connection. Stops at the first failed, missing
   * or invalid file; rejects on a network error or abort. Reports nothing either way.
   */
  async download(name, signal) {
    const options = { signal, priority: "low" };
    const response = await fetch(gameAssetUrl(clipMetadataPath(name)), options);
    if (!response.ok) return;
    const clip = await response.json();
    validateSpriteClip(clip);
    if (this.#closed) return;
    this.#clips.set(name, clip);
    for (const page of clip.pages) {
      const path = clipPagePath(name, page);
      const sheet = await fetch(gameAssetUrl(path), options);
      if (!sheet.ok) return;
      const blob = await sheet.blob();
      if (this.#closed || !(await isWebp(blob))) return;
      this.#sheets.set(path, blob);
    }
  }

  clip(name) { return this.#clips.get(name); }
  sheet(path) { return this.#sheets.get(path); }
  /** The decoded page is cached now, or the file was unusable: stop holding it. */
  release(path) { this.#sheets.delete(path); }

  close() {
    this.#closed = true;
    this.#clips.clear();
    this.#sheets.clear();
  }
}
