/** Off-main-thread sprite decoding with a browser-compatible fallback (docs/design/landing.md). */
async function decodeLocally(blob) {
  if (typeof createImageBitmap === "function") return createImageBitmap(blob);
  const image = new Image();
  const url = URL.createObjectURL(blob);
  try {
    image.src = url;
    await image.decode();
    return image;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export class SpriteDecoder {
  #nextId = 0;
  #pending = new Map();
  #worker;

  constructor() {
    if (typeof Worker === "undefined") return;
    try {
      this.#worker = new Worker(new URL("./sprite-decoder-worker.mjs", import.meta.url), {
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
    if (!this.#worker) return decodeLocally(blob);
    const id = ++this.#nextId;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { blob, resolve, reject });
      try {
        this.#worker.postMessage({ id, blob });
      } catch {
        this.#pending.delete(id);
        resolve(decodeLocally(blob));
      }
    });
  }

  #receive({ id, image, error, unsupported }) {
    const pending = this.#pending.get(id);
    if (!pending) return;
    this.#pending.delete(id);
    if (unsupported) {
      this.#disableWorker();
      pending.resolve(decodeLocally(pending.blob));
    } else if (error) pending.reject(new Error(error));
    else pending.resolve(image);
  }

  #fallbackAll() {
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    this.#disableWorker();
    for (const request of pending) request.resolve(decodeLocally(request.blob));
  }

  #disableWorker() {
    this.#worker?.terminate();
    this.#worker = undefined;
  }
}
