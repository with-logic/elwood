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
  #queued = new Set();
  #active;
  #worker;
  #disposed = false;

  constructor() {
    if (typeof Worker === "undefined") return;
    try {
      this.#worker = new Worker(new URL("./worker.mjs", import.meta.url), {
        type: "module",
      });
      this.#worker.addEventListener("message", (event) => {
        if (this.#active === event.data.id) this.#active = undefined;
        this.#receive(event.data);
        this.#dispatch();
      });
      this.#worker.addEventListener("error", () => this.#fallbackAll());
      this.#worker.addEventListener("messageerror", () => this.#fallbackAll());
    } catch {
      this.#worker = undefined;
    }
  }

  decode(blob, signal) {
    if (this.#disposed) return Promise.reject(new Error("Sprite decoder is disposed."));
    if (signal?.aborted) return Promise.reject(signal.reason);
    const id = ++this.#nextId;
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.#take(id)?.reject(signal.reason);
        try {
          if (this.#active === id) this.#worker.postMessage({ cancel: id });
        } catch {
          // A broken transport cannot delay cancellation; late images are still closed.
        }
      };
      const removeAbort = () => signal?.removeEventListener("abort", abort);
      this.#pending.set(id, { blob, resolve, reject, local: false, removeAbort });
      signal?.addEventListener("abort", abort, { once: true });
      if (!this.#worker) return this.#decodeLocally(id);
      this.#queued.add(id);
      this.#dispatch();
    });
  }

  #dispatch() {
    if (!this.#worker || this.#active !== undefined || !this.#queued.size) return;
    const id = this.#queued.values().next().value;
    this.#queued.delete(id);
    this.#active = id;
    try {
      this.#worker.postMessage({ id, blob: this.#pending.get(id).blob });
    } catch {
      this.#active = undefined;
      this.#decodeLocally(id);
      this.#dispatch();
    }
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
      this.#take(id).resolve(image);
    }
  }

  #decodeLocally(id) {
    const pending = this.#pending.get(id);
    if (pending.local) return;
    pending.local = true;
    decodeLocally(pending.blob).then(
      (image) => this.#receive({ id, image }),
      (error) => {
        this.#take(id)?.reject(error);
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
    for (const id of this.#pending.keys())
      this.#take(id).reject(new Error("Sprite decoder is disposed."));
  }

  #take(id) {
    const pending = this.#pending.get(id);
    this.#pending.delete(id);
    this.#queued.delete(id);
    pending?.removeAbort();
    return pending;
  }

  #disableWorker() {
    this.#worker?.terminate();
    this.#worker = undefined;
    this.#active = undefined;
    this.#queued.clear();
  }
}
