/** Run the shipped page/worker cancellation protocol through browser seams (PRD §13). */
import assert from "node:assert/strict";
import { SpriteDecoder } from "../../sprite-decoder/index.mjs";

let receive;
const previous = globalThis.addEventListener;
globalThis.addEventListener = (_type, callback) => { receive = callback; };
await import("../../sprite-decoder/worker.mjs");
if (previous) globalThis.addEventListener = previous;
else delete globalThis.addEventListener;

export const flush = () => new Promise((resolve) => setImmediate(resolve));

export function fixture(t, decode, { local = false, ignoreCancel = false, cancelThrows = false } = {}) {
  const processing = [];
  const sent = [];
  let worker;
  const globals = {
    createImageBitmap: decode,
    Worker: local ? undefined : class {
      listeners = new Map();
      terminated = false;
      constructor() { worker = this; }
      addEventListener(type, callback) { this.listeners.set(type, callback); }
      postMessage(data) {
        sent.push(data);
        if (data.cancel !== undefined) {
          if (cancelThrows) throw new Error("cancellation transport failed");
          if (ignoreCancel) return;
        }
        processing.push(Promise.resolve(receive({ data })));
      }
      terminate() { this.terminated = true; }
    },
    postMessage: (data) => worker.listeners.get("message")({ data }),
  };
  for (const [name, value] of Object.entries(globals)) {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
    t.after(() => original ? Object.defineProperty(globalThis, name, original) : delete globalThis[name]);
  }
  const decoder = new SpriteDecoder();
  return { decoder, worker, sent, drain: () => Promise.all(processing) };
}

export function rejection(promise, signal) {
  const state = { rejected: false };
  const done = promise.then(
    () => assert.fail("cancelled decode resolved"),
    (error) => { assert.equal(error, signal.reason); state.rejected = true; },
  );
  // Tests inspect prompt cancellation before releasing an uncancellable decode.
  // Observe failures immediately while cleanup still joins the original assertion.
  void done.catch(() => {});
  return { state, done };
}
