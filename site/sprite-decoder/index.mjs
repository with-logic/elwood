/** Off-main-thread sprite decoding with a browser-compatible fallback (PRD §13; site/docs/design/landing.md). */
import { MAX_DECODE_WORKERS, spriteLimits } from "../sprite-limits.mjs";
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
  #slots = [];
  #maxWorkers = 0;
  #disposed = false;

  constructor() {
    if (typeof Worker === "undefined") return;
    // The ceiling holds whatever a caller wrote to the shared limits.
    this.#maxWorkers = Math.min(MAX_DECODE_WORKERS, spriteLimits.maxDecodeWorkers);
    this.#spawn();
  }

  /** Later workers start only when every existing one is busy. */
  #spawn() {
    try {
      const slot = { active: undefined, hasReplied: false };
      slot.worker = new Worker(new URL("./worker.mjs", import.meta.url), {
        type: "module",
      });
      slot.worker.addEventListener("message", (event) => {
        slot.hasReplied = true;
        if (slot.active === event.data.id) slot.active = undefined;
        this.#receive(event.data);
        this.#dispatch();
      });
      slot.worker.addEventListener("error", () => this.#fail(slot));
      slot.worker.addEventListener("messageerror", () => this.#fail(slot));
      this.#slots.push(slot);
      return slot;
    } catch {
      // Keep whatever workers already started; an empty pool decodes on the page.
      this.#shrink("could not be constructed");
      return undefined;
    }
  }

  /** The pool stops growing at its current size. Decoding still succeeds, so nothing reaches
   * the asset-error path; this is the only sign that parallelism was lost.
   */
  #shrink(reason) {
    this.#maxWorkers = this.#slots.length;
    console.warn(`Sprite decoder: a worker ${reason}; ${this.#slots.length} remaining.`);
  }

  /** A worker script that cannot load reports here, not from the constructor. Two cases:
   * an additional worker that has not replied yet is dropped and its request requeued;
   * the only worker, or one that has replied, moves all decoding to the page.
   */
  #fail(slot) {
    if (slot.hasReplied || this.#slots.length === 1) return this.#fallbackAll();
    slot.worker.terminate();
    this.#slots = this.#slots.filter((other) => other !== slot);
    this.#shrink("failed before its first reply");
    // Its request returns to the front of the queue unless the caller already left.
    if (this.#pending.has(slot.active)) this.#queued = new Set([slot.active, ...this.#queued]);
    this.#dispatch();
  }

  decode(blob, signal) {
    if (this.#disposed) return Promise.reject(new Error("Sprite decoder is disposed."));
    if (signal?.aborted) return Promise.reject(signal.reason);
    const id = ++this.#nextId;
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.#take(id)?.reject(signal.reason);
        try {
          this.#slots.find((slot) => slot.active === id)?.worker.postMessage({ cancel: id });
        } catch {
          // A broken transport cannot delay cancellation; late images are still closed.
        }
      };
      const removeAbort = () => signal?.removeEventListener("abort", abort);
      this.#pending.set(id, { blob, resolve, reject, local: false, removeAbort });
      signal?.addEventListener("abort", abort, { once: true });
      if (!this.#slots.length) return this.#decodeLocally(id);
      this.#queued.add(id);
      this.#dispatch();
    });
  }

  /** The page owns the queue: each worker holds one request until it replies. */
  #dispatch() {
    while (this.#queued.size) {
      // An empty pool has a limit of zero, so it never restarts.
      const slot = this.#slots.find((candidate) => candidate.active === undefined)
        ?? (this.#slots.length < this.#maxWorkers ? this.#spawn() : undefined);
      if (!slot) return;
      const id = this.#queued.values().next().value;
      this.#queued.delete(id);
      slot.active = id;
      try {
        slot.worker.postMessage({ id, blob: this.#pending.get(id).blob });
      } catch {
        slot.active = undefined;
        this.#decodeLocally(id);
      }
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
    this.#stopWorkers();
    for (const id of this.#pending.keys()) this.#decodeLocally(id);
  }

  dispose() {
    this.#disposed = true;
    this.#stopWorkers();
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

  #stopWorkers() {
    for (const slot of this.#slots) slot.worker.terminate();
    this.#slots = [];
    this.#maxWorkers = 0;
    this.#queued.clear();
  }
}
