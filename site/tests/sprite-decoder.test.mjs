/** Browser fallback protocol, pending request settlement and URL lifetime. */
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

test("worker replies correlate out of order and decode failures reject only their request", async (t) => {
  const { decoder, worker, local } = fixture(t);
  const first = decoder.decode(new Blob(["one"]));
  const second = decoder.decode(new Blob(["two"]));
  worker.emit("message", { id: 2, image: "decoded" });
  worker.emit("message", { id: 999, error: "irrelevant" });
  worker.emit("message", { id: 1, error: "bad sheet" });
  assert.equal(await second, "decoded");
  await assert.rejects(first, /bad sheet/);
  assert.equal(worker.terminated, false);
  assert.deepEqual(local, []);
});

test("an empty worker error rejects instead of resolving an undefined image", async (t) => {
  const { decoder, worker } = fixture(t);
  const pending = decoder.decode(new Blob(["bad sheet"]));
  worker.emit("message", { id: 1, error: "" });
  await assert.rejects(pending, { name: "Error", message: "" });
});

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
