/** Execute the shipped worker module against browser API seams, including transfer ownership (PRD §13). */
import assert from "node:assert/strict";
import test from "node:test";
import { SpriteDecoder } from "../sprite-decoder/index.mjs";

let receive;
// Node lacks worker globals. Capture the actual module's listener once, then stub
// only browser decoding APIs for each protocol case.
globalThis.addEventListener = (type, callback) => {
  assert.equal(type, "message");
  receive = callback;
};
globalThis.postMessage = () => {};
await import("../sprite-decoder/worker.mjs");
async function worker(t, globals = {}) {
  const sent = [];
  t.mock.method(globalThis, "postMessage", (...message) => sent.push(message));
  for (const [name, value] of Object.entries(globals)) {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
    t.after(() => original ? Object.defineProperty(globalThis, name, original) : delete globalThis[name]);
  }
  return { sent, run: (data) => receive({ data }) };
}

test("transferred pixels remain available after the decoder terminates its worker", async (t) => {
  let live = true;
  let listener;
  const decoded = { pixels: 46889, close() { this.pixels = 0; } };
  const { run, sent } = await worker(t, {
    createImageBitmap: async () => decoded,
    // Chrome ties canvas-backed transferred pixels to the originating worker.
    OffscreenCanvas: class {
      getContext() { return { drawImage() {} }; }
      transferToImageBitmap() { return { get pixels() { return live ? 46889 : 0; } }; }
    },
    Worker: class {
      addEventListener(type, callback) { if (type === "message") listener = callback; }
      postMessage(data) { run(data); }
      terminate() { live = false; }
    },
  });
  globalThis.postMessage = (data, transfer) => { sent.push([data, transfer]); listener({ data }); };
  const decoder = new SpriteDecoder();
  const image = await decoder.decode(new Blob());
  assert.equal(image.pixels, 46889);
  decoder.dispose();
  assert.equal(image.pixels, 46889, "Worker termination must not erase delivered artwork");
  assert.equal(sent[0][1][0], image);
});

test("worker reports unsupported bitmap decoding without a transfer", async (t) => {
  const { run, sent } = await worker(t, { createImageBitmap: undefined });
  await run({ id: 4, blob: new Blob() });
  assert.deepEqual(sent, [[{ id: 4, unsupported: true }]]);
});

for (const cause of [new Error("bad sheet"), "bad sheet", new Error(""), ""]) {
  test(`worker reports ${typeof cause} decode failure ${JSON.stringify(String(cause))} with the request id`, async (t) => {
    const { run, sent } = await worker(t, { createImageBitmap: async () => { throw cause; } });
    await run({ id: 9, blob: new Blob() });
    assert.deepEqual(sent, [[{ id: 9, error: cause instanceof Error ? cause.message : cause }]]);
  });
}

test("worker closes the image and reports failure when transfer throws", async (t) => {
  let closed = 0;
  const { run, sent } = await worker(t, {
    createImageBitmap: async () => ({ close: () => closed++ }),
    OffscreenCanvas: undefined,
  });
  const post = globalThis.postMessage;
  globalThis.postMessage = (message, transfer) => {
    if (transfer) throw new Error("transfer failed");
    post(message);
  };
  await run({ id: 6, blob: new Blob() });
  assert.deepEqual(sent, [[{ id: 6, error: "transfer failed" }]]);
  assert.equal(closed, 1);
});


test("worker serializes full-atlas decoding across requests", async (t) => {
  const first = Promise.withResolvers();
  const entered = [];
  const { run, sent } = await worker(t, {
    createImageBitmap: async (blob) => {
      entered.push(await blob.text());
      if (entered.length === 1) await first.promise;
      return { close() {} };
    },
    OffscreenCanvas: undefined,
  });
  const a = run({ id: 1, blob: new Blob(["first"]) });
  const b = run({ id: 2, blob: new Blob(["second"]) });
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(entered, ["first"]);
  } finally {
    first.resolve();
    await Promise.all([a, b]);
  }
  assert.deepEqual(entered, ["first", "second"]);
  assert.deepEqual(sent.map(([message]) => message.id), [1, 2]);
});


for (const stage of ["decode", "transfer"]) {
  test(`real worker ${stage} failure completes through the page decoder`, async (t) => {
    let listener;
    let processing;
    let decodes = 0;
    const local = { bitmap: "local" };
    const { run } = await worker(t, {
      Worker: class {
        addEventListener(type, callback) { if (type === "message") listener = callback; }
        postMessage(data) { processing = run(data); }
      },
      createImageBitmap: async () => {
        if (++decodes === 2) return local;
        if (stage === "decode") throw new Error("worker decode failed");
        return { width: 1, height: 1, close() {} };
      },
      OffscreenCanvas: undefined,
    });
    globalThis.postMessage = (data, transfer) => {
      if (stage === "transfer" && transfer) throw new Error("transfer failed");
      listener({ data });
    };
    assert.equal(await new SpriteDecoder().decode(new Blob()), local);
    await processing;
    assert.equal(decodes, 2);
  });
}


test("a failed response does not leave later worker requests behind a rejected queue", async (t) => {
  const { run, sent } = await worker(t, { createImageBitmap: undefined });
  const post = globalThis.postMessage;
  globalThis.postMessage = () => { throw new Error("response failed"); };
  await assert.rejects(run({ id: 1, blob: new Blob() }), /response failed/);
  globalThis.postMessage = post;
  await run({ id: 2, blob: new Blob() });
  assert.deepEqual(sent, [[{ id: 2, unsupported: true }]]);
});
