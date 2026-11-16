/** Sprite sheets decode in several workers at once (PRD §13, C-SITE-05). */
import assert from "node:assert/strict";
import test from "node:test";
import { SpriteDecoder } from "../sprite-decoder/index.mjs";
import { limitsFor, spriteLimits } from "../sprite-limits.mjs";

function fixture(t, { failFrom = Infinity } = {}) {
  const workers = [];
  const local = [];
  const globals = {
    Worker: class {
      listeners = new Map();
      sent = [];
      terminated = false;
      constructor() {
        if (workers.length >= failFrom) throw new Error("worker limit");
        workers.push(this);
      }
      addEventListener(type, listener) { this.listeners.set(type, listener); }
      postMessage(message) { this.sent.push(message); }
      terminate() { this.terminated = true; }
      reply(data) { this.listeners.get("message")({ data }); }
    },
    createImageBitmap: async (blob) => { local.push(blob); return blob; },
  };
  for (const [name, value] of Object.entries(globals)) {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
    t.after(() => original ? Object.defineProperty(globalThis, name, original) : delete globalThis[name]);
  }
  const pool = (workerLimit) => {
    const original = spriteLimits.maxDecodeWorkers;
    t.after(() => { spriteLimits.maxDecodeWorkers = original; });
    spriteLimits.maxDecodeWorkers = workerLimit;
    return new SpriteDecoder();
  };
  return { workers, local, pool };
}
const decodes = (worker) => worker.sent.filter((message) => message.blob).map((message) => message.id);

for (const [hardwareConcurrency, workers] of [[undefined, 1], [1, 1], [2, 1], [3, 2], [4, 3], [5, 4], [16, 4]]) {
  test(`C-SITE-05 ${hardwareConcurrency ?? "unreported"} cores decode in ${workers} worker(s), leaving one core for painting`, () => {
    assert.equal(limitsFor({ hardwareConcurrency }).maxDecodeWorkers, workers);
  });
}

test("C-SITE-05 busy workers add another up to the limit, then requests queue on the page", (t) => {
  const { workers, pool } = fixture(t);
  const decoder = pool(3);
  assert.equal(workers.length, 1, "one worker starts with the decoder");
  const pending = [1, 2, 3, 4, 5].map(() => decoder.decode(new Blob()));
  assert.equal(workers.length, 3);
  assert.deepEqual(workers.map(decodes), [[1], [2], [3]]);
  const second = { name: "second" };
  workers[1].reply({ id: 2, image: second });
  assert.deepEqual(workers.map(decodes), [[1], [2, 4], [3]], "the freed worker takes the oldest queued request");
  workers[0].reply({ id: 1, image: {} });
  workers[0].reply({ id: 5, image: {} });
  assert.deepEqual(workers.map(decodes), [[1, 5], [2, 4], [3]]);
  assert.equal(workers.length, 3, "an idle worker is reused before another starts");
  workers[1].reply({ id: 4, image: {} });
  workers[2].reply({ id: 3, image: {} });
  return Promise.all(pending).then((images) => assert.equal(images[1], second));
});

test("C-SITE-05 a sequence of single decodes keeps one worker", async (t) => {
  const { workers, pool } = fixture(t);
  const decoder = pool(4);
  for (const id of [1, 2, 3]) {
    const pending = decoder.decode(new Blob());
    workers[0].reply({ id, image: { id } });
    assert.equal((await pending).id, id);
  }
  assert.equal(workers.length, 1);
});

test("C-SITE-05 a worker that cannot start leaves the existing pool decoding", async (t) => {
  const { workers, local, pool } = fixture(t, { failFrom: 2 });
  const decoder = pool(4);
  const pending = [1, 2, 3, 4].map(() => decoder.decode(new Blob()));
  assert.equal(workers.length, 2);
  assert.deepEqual(workers.map(decodes), [[1], [2]]);
  workers[0].reply({ id: 1, image: {} });
  workers[1].reply({ id: 2, image: {} });
  assert.deepEqual(workers.map(decodes), [[1, 3], [2, 4]], "queued requests wait for the workers that did start");
  workers[0].reply({ id: 3, image: {} });
  workers[1].reply({ id: 4, image: {} });
  await Promise.all(pending);
  assert.deepEqual(local, [], "nothing falls back to the page while a worker remains");
});

test("C-SITE-05 cancelling an active decode tells only its own worker and holds that slot until it replies", async (t) => {
  const { workers, pool } = fixture(t);
  const decoder = pool(2);
  const controller = new AbortController();
  const first = decoder.decode(new Blob());
  const cancelled = decoder.decode(new Blob(), controller.signal);
  const third = decoder.decode(new Blob());
  controller.abort(new Error("superseded"));
  await assert.rejects(cancelled, /superseded/);
  assert.deepEqual(workers[1].sent.at(-1), { cancel: 2 });
  assert.equal(workers[0].sent.some((message) => message.cancel !== undefined), false);
  assert.deepEqual(workers.map(decodes), [[1], [2]], "the cancelled decode still occupies its worker");
  workers[1].reply({ id: 2, cancelled: true });
  assert.deepEqual(workers.map(decodes), [[1], [2, 3]]);
  workers[0].reply({ id: 1, image: {} });
  workers[1].reply({ id: 3, image: {} });
  await Promise.all([first, third]);
});

test("C-SITE-05 a later worker that fails before its first reply only shrinks the pool", async (t) => {
  const { workers, local, pool } = fixture(t);
  const decoder = pool(3);
  const pending = [1, 2, 3, 4].map(() => decoder.decode(new Blob()));
  assert.deepEqual(workers.map(decodes), [[1], [2], [3]]);
  // A worker script that cannot load reports asynchronously, after the constructor returned.
  workers[1].listeners.get("error")();
  assert.deepEqual(workers.map((worker) => worker.terminated), [false, true, false]);
  workers[0].reply({ id: 1, image: {} });
  assert.deepEqual(decodes(workers[0]), [1, 2], "its request returns to the front of the queue");
  workers[2].reply({ id: 3, image: {} });
  assert.deepEqual(decodes(workers[2]), [3, 4]);
  workers[0].reply({ id: 2, image: {} });
  workers[2].reply({ id: 4, image: {} });
  await Promise.all(pending);
  const fifth = decoder.decode(new Blob());
  const sixth = decoder.decode(new Blob());
  const seventh = decoder.decode(new Blob());
  assert.equal(workers.length, 3, "the lost worker is not replaced");
  assert.deepEqual([decodes(workers[0]), decodes(workers[2])], [[1, 2, 5], [3, 4, 6]]);
  workers[0].reply({ id: 5, image: {} });
  workers[2].reply({ id: 6, image: {} });
  workers[0].reply({ id: 7, image: {} });
  await Promise.all([fifth, sixth, seventh]);
  assert.deepEqual(local, [], "nothing falls back to the page while a worker remains");
});

test("C-SITE-05 a failed worker does not requeue a request its caller already cancelled", async (t) => {
  const { workers, pool } = fixture(t);
  const decoder = pool(2);
  const controller = new AbortController();
  const first = decoder.decode(new Blob());
  const cancelled = decoder.decode(new Blob(), controller.signal);
  controller.abort(new Error("superseded"));
  await assert.rejects(cancelled, /superseded/);
  workers[1].listeners.get("messageerror")();
  workers[0].reply({ id: 1, image: {} });
  await first;
  assert.deepEqual(decodes(workers[0]), [1]);
});

test("C-SITE-05 a worker that fails after replying moves every pending request to the page and stops the pool", async (t) => {
  const { workers, local, pool } = fixture(t);
  const decoder = pool(2);
  const blobs = [new Blob(["a"]), new Blob(["b"]), new Blob(["c"]), new Blob(["d"])];
  const started = decoder.decode(new Blob(["warm"]));
  const alsoStarted = decoder.decode(new Blob(["warm"]));
  workers[0].reply({ id: 1, image: {} });
  workers[1].reply({ id: 2, image: {} });
  await Promise.all([started, alsoStarted]);
  const pending = blobs.slice(0, 3).map((blob) => decoder.decode(blob));
  workers[1].listeners.get("error")();
  assert.deepEqual(workers.map((worker) => worker.terminated), [true, true]);
  pending.push(decoder.decode(blobs[3]));
  assert.deepEqual(await Promise.all(pending), blobs);
  assert.deepEqual(local, blobs);
  assert.equal(workers.length, 2, "no worker restarts after a failure");
});
