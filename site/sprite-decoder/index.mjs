/** Off-main-thread sprite decoding with a browser-compatible fallback (PRD §13; site/docs/design/landing.md). */
import { releaseSpriteImage } from "./release.mjs";

async function decodeOnPage(blob) {
  if (typeof createImageBitmap === "function") return createImageBitmap(blob);
  const image = new Image();
  const url = URL.createObjectURL(blob);
  let decoded = false;
  try {
    image.src = url;
    await image.decode();
    decoded = true;
    return image;
  } finally {
    if (!decoded) releaseSpriteImage(image);
    URL.revokeObjectURL(url);
  }
}

async function decodeLocally(blob) {
  try {
    return await decodeOnPage(blob);
  } catch (cause) {
    if (cause instanceof Error && cause.message.trim()) throw cause;
    throw new Error("Sprite sheet decoding failed. Try again.", { cause });
  }
}

export class SpriteDecoder {
  #nextId = 0;
  #pending = new Map();
  #worker;
  #disposed = false;

  constructor() {
    if (typeof Worker === "undefined") return;
    try {
      this.#worker = new Worker(new URL("./worker.mjs", import.meta.url), {
        type: "module",
      });
      this.#worker.addEventListener("message", (event) => this.#receive(event.data));
      this.#worker.addEventListener("error", () => this.#fallbackAll());
      this.#worker.addEventListener("messageerror", () => this.#fallbackAll());
    } catch {
      this.#worker = undefined;
    }
  }

  decode(blob) {
    if (this.#disposed) return Promise.reject(new Error("Sprite decoder is disposed."));
    const id = ++this.#nextId;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { blob, resolve, reject, local: false });
      if (!this.#worker) return this.#decodeLocally(id);
      try {
        this.#worker.postMessage({ id, blob });
      } catch {
        this.#decodeLocally(id);
      }
    });
  }

  #receive({ id, image, error, unsupported }) {
    const pending = this.#pending.get(id);
    if (!pending) {
      if (image) releaseSpriteImage(image);
      return;
    }
    if (unsupported) this.#fallbackAll();
    else if (error !== undefined) this.#decodeLocally(id);
    else {
      this.#pending.delete(id);
      pending.resolve(image);
    }
  }

  #decodeLocally(id) {
    const pending = this.#pending.get(id);
    if (pending.local) return;
    pending.local = true;
    decodeLocally(pending.blob).then(
      (image) => this.#receive({ id, image }),
      (error) => {
        this.#pending.delete(id);
        pending.reject(error);
      },
    );
  }

  #fallbackAll() {
    this.#disableWorker();
    for (const id of this.#pending.keys()) this.#decodeLocally(id);
  }

  dispose() {
    this.#disposed = true;
    this.#disableWorker();
    for (const pending of this.#pending.values())
      pending.reject(new Error("Sprite decoder is disposed."));
    this.#pending.clear();
  }

  #disableWorker() {
    this.#worker?.terminate();
    this.#worker = undefined;
  }
}
