/** Failed and HTML sprite ownership cleanup (PRD §13; docs/design/landing.md). */
import assert from "node:assert/strict";
import test from "node:test";
import { SpriteBank } from "../sprite-bank.mjs";

function fixture(t, { decode = async () => {}, bitmap = false } = {}) {
  const original = { Image: globalThis.Image, fetch: globalThis.fetch };
  globalThis.fetch = async () => new Response("sheet");
  const images = [];
  globalThis.Image = class {
    src = "";
    released = 0;
    constructor() {
      images.push(this);
      if (bitmap) this.close = () => this.released++;
    }
    decode() { return decode(); }
    removeAttribute(name) { assert.equal(name, "src"); this.src = ""; this.released++; }
  };
  const errors = [];
  const bank = new SpriteBank((error) => errors.push(error));
  bank.clips.set("wave", {
    pages: Array.from({ length: 6 }, (_, i) => ({ file: `${i}.webp` })),
    frames: [{ page: 0 }],
  });
  t.after(() => { bank.dispose(); Object.assign(globalThis, original); });
  return { bank, errors, images, page: (index) => bank.loadPage("wave", index) };
}

for (const bitmap of [false, true]) {
  test(`failed ${bitmap ? "bitmap" : "HTML image"} decoding releases the resource and preserves its error`, async (t) => {
    const cause = new Error("decoder failed");
    const { bank, images, page } = fixture(t, { bitmap, decode: async () => { throw cause; } });
    await assert.rejects(page(0), (error) => error === cause);
    assert.equal(images[0].released, 1);
    assert.equal(bank.pages.size, 0);
  });
}

test("HTML image sources survive active poses and are removed on eviction/release/disposal", async (t) => {
  const { bank, images, page } = fixture(t);
  const pose = { page: await page(0) };
  bank.retainPoses(pose);
  for (let i = 1; i < 6; i++) await page(i);
  assert.notEqual(pose.page.src, "");
  assert.equal(images[1].src, "", "unretained eviction releases src");
  bank.retainPoses();
  assert.equal(pose.page.src, "", "last pose release removes src");
  bank.dispose();
  assert.ok(images.every((image) => image.src === "" && image.released === 1));
});

test("frame failure after disposal releases its image without reporting a stale UI error", async (t) => {
  const gate = Promise.withResolvers();
  const { bank, errors, images } = fixture(t, { decode: () => gate.promise });
  bank.frame("wave", 0);
  await new Promise((resolve) => setImmediate(resolve));
  bank.dispose();
  gate.reject(new Error("late image failure"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(errors, []);
  assert.equal(images[0].released, 1);
});

test("an HTML decode completing after disposal releases its source", async (t) => {
  const gate = Promise.withResolvers();
  const { bank, images, page } = fixture(t, { decode: () => gate.promise });
  const pending = page(0);
  await new Promise((resolve) => setImmediate(resolve));
  bank.dispose();
  await assert.rejects(pending, /disposed/);
  gate.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(images[0].src, "");
  assert.equal(images[0].released, 1);
});
