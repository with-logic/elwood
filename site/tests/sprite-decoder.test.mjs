/** Browser fallback protocol, pending request settlement and URL lifetime (PRD §13). */
import assert from "node:assert/strict";
import { resolveObjectURL } from "node:buffer";
import test from "node:test";
import { SpriteDecoder } from "../sprite-decoder/index.mjs";
import { SpriteBank } from "../sprite-bank.mjs";

function fixture(t, { constructorFails = false, sendFails = false, bitmap = true } = {}) {
  let worker;
  const local = [];
  const globals = {
    Worker: class {
      listeners = new Map();
      sent = [];
      terminated = false;
      constructor(url, options) {
        if (constructorFails) throw new Error("blocked worker");
        assert.equal(url.pathname.endsWith("/sprite-decoder/worker.mjs"), true);
        assert.deepEqual(options, { type: "module" });
        worker = this;
      }
      addEventListener(type, listener) { this.listeners.set(type, listener); }
      postMessage(message) { if (sendFails) throw new Error("clone failed"); this.sent.push(message); }
      terminate() { this.terminated = true; }
      emit(type, data) { this.listeners.get(type)({ data }); }
    },
    createImageBitmap: bitmap ? async (blob) => { local.push(blob); return blob; } : undefined,
  };
  for (const [name, value] of Object.entries(globals)) {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
    t.after(() => original ? Object.defineProperty(globalThis, name, original) : delete globalThis[name]);
  }
  const decoder = new SpriteDecoder();
  return { decoder, get worker() { return worker; }, local };
}

for (const event of ["unsupported", "error", "messageerror"]) {
  test(`${event} falls back every pending request and future requests`, async (t) => {
    const { decoder, worker, local } = fixture(t);
    const blobs = [new Blob(["a"]), new Blob(["b"]), new Blob(["c"])];
    const pending = blobs.slice(0, 2).map((blob) => decoder.decode(blob));
    if (event === "unsupported") worker.emit("message", { id: 1, unsupported: true });
    else worker.emit(event);
    assert.equal(worker.terminated, true);
    assert.equal(local.length, 2, "all pending requests enter fallback immediately");
    pending.push(decoder.decode(blobs[2]));
    assert.deepEqual(await Promise.all(pending), blobs);
    assert.deepEqual(local, blobs);
    assert.equal(worker.sent.length, 2);
  });
}

test("worker replies correlate out of order and failed processing falls back only its request", async (t) => {
  const { decoder, worker, local } = fixture(t);
  const blob = new Blob(["one"]);
  const first = decoder.decode(blob);
  const second = decoder.decode(new Blob(["two"]));
  worker.emit("message", { id: 2, image: "decoded" });
  worker.emit("message", { id: 999, error: "irrelevant" });
  worker.emit("message", { id: 1, error: "bad sheet" });
  assert.equal(await second, "decoded");
  assert.equal(await first, blob);
  assert.equal(worker.terminated, false);
  assert.deepEqual(local, [blob]);
});

for (const cause of [new Error(""), ""]) {
  test(`empty ${typeof cause} failures leave a visible SpriteBank diagnostic`, async (t) => {
    const setup = fixture(t);
    globalThis.createImageBitmap = async () => { throw cause; };
    const messages = [];
    const bank = new SpriteBank((error) => messages.push(error.message));
    bank.clips.set("wave", { pages: [{ file: "0.webp" }], frames: [{ page: 0 }] });
    const previous = globalThis.fetch;
    globalThis.fetch = async () => new Response("sheet");
    t.after(() => { globalThis.fetch = previous; });
    bank.frame("wave", 0);
    await new Promise((resolve) => setImmediate(resolve));
    setup.worker.emit("message", { id: 1, error: "" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(messages, ["Sprite sheet decoding failed. Try again."]);
  });

}

for (const options of [{ constructorFails: true }, { sendFails: true }]) {
  test(`local bitmap fallback handles ${Object.keys(options)[0]}`, async (t) => {
    const { decoder, local } = fixture(t, options);
    const blob = new Blob(["sheet"]);
    assert.equal(await decoder.decode(blob), blob);
    assert.deepEqual(local, [blob]);
  });
}

for (const fails of [false, true]) {
  test(`Image.decode fallback revokes its blob URL on ${fails ? "failure" : "success"}`, async (t) => {
    const { decoder } = fixture(t, { constructorFails: true, bitmap: false });
    const previous = globalThis.Image;
    let url;
    globalThis.Image = class {
      async decode() {
        url = this.src;
        assert.equal(await resolveObjectURL(url).text(), "sheet");
        if (fails) throw new Error("invalid image");
      }
    };
    t.after(() => { globalThis.Image = previous; });
    const result = decoder.decode(new Blob(["sheet"]));
    if (fails) await assert.rejects(result, /invalid image/);
    else assert.equal((await result).src, url);
    assert.equal(resolveObjectURL(url), undefined);
  });
}

test("SpriteBank shares a worker decode and retries a failed download", { timeout: 2000 }, async (t) => {
  const setup = fixture(t);
  const previousImage = globalThis.Image;
  globalThis.Image = class { async decode() {} };
  t.after(() => { globalThis.Image = previousImage; });
  const bank = new SpriteBank(() => {});
  const worker = setup.worker;
  bank.clips.set("idle", { pages: [{ file: "page-000.webp" }] });
  const previous = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => new Response("sheet", { status: ++requests === 1 ? 503 : 200 });
  t.after(() => { globalThis.fetch = previous; });
  await assert.rejects(bank.loadPage("idle", 0), /Couldn’t load idle/);
  assert.equal(bank.pendingPages.size, 0);
  const first = bank.loadPage("idle", 0);
  const second = bank.loadPage("idle", 0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(worker.sent.length, 1);
  assert.equal(await worker.sent[0].blob.text(), "sheet");
  worker.emit("message", { id: worker.sent[0].id, image: "image" });
  assert.deepEqual(await Promise.all([first, second]), ["image", "image"]);
  assert.equal(await bank.loadPage("idle", 0), "image");
  assert.equal(requests, 2);
  assert.deepEqual(setup.local, []);
});

test("a browser without Worker uses local bitmap decoding and propagates its failure", async (t) => {
  fixture(t);
  globalThis.Worker = undefined;
  globalThis.createImageBitmap = async () => { throw new Error("invalid bitmap"); };
  await assert.rejects(new SpriteDecoder().decode(new Blob()), /invalid bitmap/);
});


test("disposal rejects pending and new work, terminates the worker, and closes late transfers", async (t) => {
  const { decoder, worker } = fixture(t);
  const pending = decoder.decode(new Blob());
  decoder.dispose();
  assert.equal(worker.terminated, true);
  await assert.rejects(pending, /disposed/);
  await assert.rejects(decoder.decode(new Blob()), /disposed/);
  let closed = 0;
  worker.emit("message", { id: 1, image: { close: () => closed++ } });
  assert.equal(closed, 1);
  decoder.dispose();
});

test("disposal rejects an in-flight local decode and releases its eventual bitmap", async (t) => {
  const { decoder } = fixture(t, { constructorFails: true });
  const gate = Promise.withResolvers();
  globalThis.createImageBitmap = () => gate.promise;
  const pending = decoder.decode(new Blob());
  decoder.dispose();
  await assert.rejects(pending, /disposed/);
  let closed = 0;
  gate.resolve({ close: () => closed++ });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, 1);
});


test("repeated worker failures share an already running local fallback", async (t) => {
  const { decoder, worker } = fixture(t);
  const gate = Promise.withResolvers();
  let calls = 0;
  globalThis.createImageBitmap = () => { calls++; return gate.promise; };
  const pending = decoder.decode(new Blob());
  worker.emit("error");
  worker.emit("messageerror");
  assert.equal(calls, 1);
  gate.resolve("bitmap");
  assert.equal(await pending, "bitmap");
});
