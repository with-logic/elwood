/** Decoded preparation ownership stays bounded and cannot evict live animation. */
import { resolveObjectURL } from "node:buffer";
import assert from "node:assert/strict";
import test from "node:test";
import { SpriteBank } from "../sprite-bank.mjs";

const clip = (count) => ({
  pages: Array.from({ length: count }, (_, i) => ({ file: `${i}.webp` })),
  frames: Array.from({ length: count }, (_, page) => ({ page })),
});
function fixture(t, decode = async () => {}) {
  const fetch = globalThis.fetch;
  const Image = globalThis.Image;
  const urls = [];
  globalThis.fetch = async (url) => new Response(String(url));
  globalThis.Image = class {
    async decode() {
      urls.push(this.src);
      await decode(await resolveObjectURL(this.src).text());
    }
  };
  t.after(() => { globalThis.fetch = fetch; globalThis.Image = Image; });
  const bank = new SpriteBank(() => {});
  bank.clips.set("idle", clip(2));
  bank.clips.set("rotation", clip(3));
  return { bank, urls };
}
function drawable(bank, name, count) {
  for (let i = 0; i < count; i++) assert.ok(bank.frame(name, i), `${name}/${i} stays drawable`);
}

test("a six-page replacement cannot evict boot idle or activate itself; rotation and return idle stay resident", async (t) => {
  const gate = Promise.withResolvers();
  const entered = Promise.withResolvers();
  const { bank } = fixture(t, async (url) => {
    if (url.includes("large/5.webp")) { entered.resolve(); await gate.promise; }
  });
  bank.clips.set("large", clip(6));
  await bank.prepareAnimation("idle");
  bank.activate("idle");
  const preparation = bank.prepareAnimation("large");
  try {
    await entered.promise;
    drawable(bank, "idle", 2);
    assert.equal(bank.activeName, "idle");
    assert.equal(bank.animationReady("large"), false);
    gate.resolve();
    await preparation;
    assert.equal(bank.activeName, "idle", "only display activation can replace the active owner");
    bank.activate("large");
    drawable(bank, "large", 6);
    bank.clips.set("replacement", clip(6));
    await bank.prepareAnimation("replacement");
    assert.equal(bank.activeName, "large");
    drawable(bank, "large", 6);
    bank.activate("replacement");
    drawable(bank, "replacement", 6);
    bank.activate("rotation");
    drawable(bank, "rotation", 3);
    bank.activate("idle");
    drawable(bank, "idle", 2);
    assert.ok(bank.pages.size <= 4);
  } finally { gate.resolve(); await preparation; }
});

test("rapid distinct preparations coalesce behind one decode and discard cancelled candidates", async (t) => {
  const gate = Promise.withResolvers();
  const entered = Promise.withResolvers();
  const decoded = [];
  let inFlight = 0;
  let peak = 0;
  const { bank } = fixture(t, async (url) => {
    peak = Math.max(peak, ++inFlight);
    decoded.push(url);
    if (url.includes("old/0.webp")) { entered.resolve(); await gate.promise; }
    inFlight--;
  });
  for (const name of ["old", "a", "b", "c", "latest"]) bank.clips.set(name, clip(6));
  await bank.prepareAnimation("idle");
  bank.activate("idle");
  const old = bank.prepareAnimation("old");
  await entered.promise;
  const waiting = ["a", "b", "c", "latest"].map((name) => bank.prepareAnimation(name));
  try {
    drawable(bank, "idle", 2);
    gate.resolve();
    await Promise.all([old, ...waiting]);
    assert.equal(peak, 1);
    assert.equal(decoded.filter((url) => /\/(?:a|b|c)\//.test(url)).length, 0);
    assert.equal(decoded.filter((url) => url.includes("/old/")).length, 1);
    assert.equal(bank.prepared.name, "latest");
    assert.equal(bank.activeName, "idle");
    bank.cancelPreparation();
    assert.equal(bank.prepared, null);
    drawable(bank, "rotation", 3);
    drawable(bank, "idle", 2);
  } finally { gate.resolve(); await Promise.all([old, ...waiting]); }
});

test("failed decoding retries through source loading and revokes every object URL", async (t) => {
  let fail = true;
  const { bank, urls } = fixture(t, async () => { if (fail) throw new Error("decode"); });
  await assert.rejects(bank.loadPage("idle", 0), /decode/);
  fail = false;
  await bank.loadPage("idle", 0);
  assert.equal(urls.length, 2);
  for (const url of urls) assert.equal(resolveObjectURL(url), undefined);
});

test("one preparation downloads its missing sheets in parallel before serial decoding", async (t) => {
  const { bank, urls } = fixture(t);
  await bank.prepareAnimation("idle");
  bank.activate("idle");
  bank.clips.set("large", clip(6));
  const gate = Promise.withResolvers();
  const entered = Promise.withResolvers();
  const requested = [];
  globalThis.fetch = async (url) => {
    requested.push(String(url));
    if (requested.length === 9) entered.resolve();
    await gate.promise;
    return new Response(String(url));
  };
  const preparation = bank.prepareAnimation("large");
  try {
    await entered.promise;
    assert.equal(urls.length, 2, "downloads overlap without starting candidate decodes");
    drawable(bank, "idle", 2);
    gate.resolve();
    await preparation;
    assert.equal(bank.animationReady("large"), true);
  } finally { gate.resolve(); await preparation; }
});
