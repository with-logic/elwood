/** Sprite resource ownership and teardown (PRD §13; docs/design/landing.md). */
import assert from "node:assert/strict";
import test from "node:test";
import { SpriteBank } from "../sprite-bank.mjs";

function fixture(t, decode = async () => {}) {
  const originalImage = globalThis.Image;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("sheet");
  const images = [];
  globalThis.Image = class {
    closed = 0;
    constructor() {
      images.push(this);
    }
    decode() {
      return decode();
    }
    close() {
      this.closed++;
    }
  };
  const bank = new SpriteBank(() => {});
  bank.clips.set("clip", {
    pages: Array.from({ length: 8 }, (_, n) => ({ file: `${n}.webp` })),
    frames: [{ page: 0 }],
  });
  t.after(() => {
    bank.dispose?.();
    globalThis.Image = originalImage;
    globalThis.fetch = originalFetch;
  });
  return { bank, images, page: (index) => bank.loadPage("clip", index) };
}

test("eviction closes an unreferenced bitmap-like resource exactly once", async (t) => {
  const { bank, images, page } = fixture(t);
  for (let i = 0; i < 5; i++) await page(i);
  assert.equal(bank.pages.size, 4);
  assert.equal(images[0].closed, 1);
  assert.equal(images[1].closed, 0);
});

test("current and outgoing poses survive eviction until their last owner releases", async (t) => {
  const { bank, page } = fixture(t);
  const current = { page: await page(0) };
  const outgoing = { page: await page(1) };
  bank.retainPoses(current, outgoing);
  for (let i = 2; i < 6; i++) await page(i);
  assert.equal(current.page.closed, 0);
  assert.equal(outgoing.page.closed, 0);
  bank.retainPoses(current);
  assert.equal(outgoing.page.closed, 1);
  bank.retainPoses(null, current);
  assert.equal(current.page.closed, 0, "Transfer between owners must not close the page");
  bank.retainPoses();
  assert.equal(current.page.closed, 1);
  bank.retainPoses();
  assert.equal(current.page.closed, 1);
});

test("release leaves a cached page usable; teardown closes cached and retained pages once", async (t) => {
  const { bank, images, page } = fixture(t);
  let disposed = 0;
  const decoder = bank.decoder;
  bank.decoder = {
    decode: (blob) => decoder.decode(blob),
    dispose() {
      decoder.dispose();
      disposed++;
    },
  };
  const pose = { page: await page(0) };
  bank.retainPoses(pose, pose);
  bank.retainPoses();
  assert.equal(pose.page.closed, 0);
  bank.retainPoses(pose);
  for (let i = 1; i < 6; i++) await page(i);
  bank.dispose();
  bank.dispose();
  assert.ok(images.every((image) => image.closed === 1));
  assert.equal(bank.pages.size, 0);
  assert.equal(bank.frame("clip", 0), null);
  await assert.rejects(page(0), /disposed/i);
  await assert.rejects(bank.load("clip"), /disposed/i);
  assert.equal(images.length, 6);
  assert.equal(disposed, 1);
});

test("late metadata cannot repopulate a disposed bank", async (t) => {
  const { bank, images } = fixture(t);
  let finish;
  const metadata = new Promise((resolve) => {
    finish = resolve;
  });
  globalThis.fetch = async () => ({ ok: true, json: () => metadata });
  const pending = bank.load("late");
  await Promise.resolve();
  bank.dispose();
  finish({ pages: [] });
  await assert.rejects(pending, /disposed/i);
  assert.equal(bank.clips.size, 0);
  assert.equal(bank.clipPromises.size, 0);
  assert.equal(images.length, 0);
});

test("a decode finishing after disposal closes without repopulating the bank", async (t) => {
  let finish;
  const decoding = new Promise((resolve) => {
    finish = resolve;
  });
  const { bank, images, page } = fixture(t, () => decoding);
  const pending = page(0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(images.length, 1);
  bank.dispose();
  finish();
  await assert.rejects(pending, /disposed/i);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(images[0].closed, 1);
  assert.equal(bank.pages.size, 0);
  assert.equal(bank.pendingPages.size, 0);
});
