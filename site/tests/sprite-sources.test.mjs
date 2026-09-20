/** Compressed sheets survive decoded-page eviction without unbounded memory or failed-load poisoning. */
import assert from "node:assert/strict";
import test from "node:test";
import { SpriteSources } from "../sprite-sources.mjs";
import { SpriteBank } from "../sprite-bank.mjs";

test("compressed sheets deduplicate downloads and evict least recently used bytes", async () => {
  const fetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    return new Response("1234");
  };
  try {
    const sources = new SpriteSources(8);
    const [first, duplicate] = await Promise.all([sources.load("a"), sources.load("a")]);
    assert.equal(first, duplicate);
    await sources.load("b");
    assert.equal(await sources.load("a"), first);
    await sources.load("c");
    assert.deepEqual(requests, ["a", "b", "c"]);
    assert.equal(sources.has("b"), false);
    assert.equal(sources.bytes, 8);
    const small = new SpriteSources(2);
    await small.load("large");
    assert.equal(small.bytes, 0);
  } finally { globalThis.fetch = fetch; }
});

test("failed sheet downloads can retry", async () => {
  const fetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async () => new Response("image", { status: ++attempts === 1 ? 503 : 200 });
  try {
    const sources = new SpriteSources();
    await assert.rejects(sources.load("sheet"), /Couldn’t load/);
    assert.equal(await (await sources.load("sheet")).text(), "image");
  } finally { globalThis.fetch = fetch; }
});

test("decoding an evicted sheet reuses compressed bytes and always releases its object URL", async () => {
  const fetch = globalThis.fetch;
  const Image = globalThis.Image;
  const urls = [];
  let downloads = 0;
  globalThis.fetch = async () => { downloads++; return new Response("image"); };
  globalThis.Image = class { async decode() { urls.push(this.src); } };
  try {
    const bank = new SpriteBank(() => {});
    bank.clips.set("test", { pages: [{ file: "0.webp" }], frames: [{ page: 0 }] });
    assert.equal(bank.animationReady("test"), false);
    await bank.prepare("test");
    bank.pages.clear();
    await bank.loadPage("test", 0);
    assert.equal(downloads, 1);
    assert.equal(urls.length, 2);
    for (const url of urls) await assert.rejects(fetch(url));
    bank.pages.clear();
    globalThis.Image = class { async decode() { urls.push(this.src); throw new Error("decode"); } };
    await assert.rejects(bank.loadPage("test", 0), /decode/);
    await assert.rejects(fetch(urls.at(-1)));
  } finally { globalThis.fetch = fetch; globalThis.Image = Image; }
});

test("a six-sheet animation stays drawable while its replacement is still loading", async () => {
  const fetch = globalThis.fetch;
  const Image = globalThis.Image;
  let release;
  let notify;
  const pending = new Promise((resolve) => { notify = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  globalThis.fetch = async (url) => {
    if (String(url).includes("replacement")) { notify(); await gate; }
    return new Response("image");
  };
  globalThis.Image = class { async decode() {} };
  const bank = new SpriteBank(() => {});
  const clip = {
    pages: Array.from({ length: 6 }, (_, index) => ({ file: `${index}.webp` })),
    frames: Array.from({ length: 6 }, (_, page) => ({ page })),
  };
  for (const name of ["long", "replacement", "newest"]) bank.clips.set(name, clip);
  let replacement;
  try {
    await bank.prepareAnimation("long");
    replacement = bank.prepareAnimation("replacement");
    await pending;
    for (let index = 0; index < 6; index++) assert.ok(bank.frame("long", index));
    assert.ok(bank.pages.size <= 4);
    await bank.prepareAnimation("newest");
    release();
    await replacement;
    assert.equal(bank.animationReady("newest"), true, "a stale load cannot evict newer playback");
    assert.equal(bank.playback.size, 6);
    assert.ok(bank.pages.size <= 4);
  } finally {
    release();
    await replacement;
    globalThis.fetch = fetch;
    globalThis.Image = Image;
  }
});

test("animation preparation waits for the last sheet to decode", async () => {
  const fetch = globalThis.fetch;
  const Image = globalThis.Image;
  let release;
  let notify;
  let decodes = 0;
  const decoding = new Promise((resolve) => { notify = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  globalThis.fetch = async () => new Response("image");
  globalThis.Image = class {
    async decode() {
      if (++decodes === 2) { notify("decoding"); await gate; }
    }
  };
  const bank = new SpriteBank(() => {});
  bank.clips.set("two", {
    pages: [{ file: "a.webp" }, { file: "b.webp" }],
    frames: [{ page: 0 }, { page: 1 }],
  });
  const ready = bank.prepareAnimation("two").then(() => "ready");
  try {
    assert.equal(await Promise.race([ready, decoding]), "decoding");
    assert.equal(bank.animationReady("two"), false);
    release();
    await ready;
    assert.ok(bank.frame("two", 1));
  } finally {
    release();
    await ready;
    globalThis.fetch = fetch;
    globalThis.Image = Image;
  }
});
