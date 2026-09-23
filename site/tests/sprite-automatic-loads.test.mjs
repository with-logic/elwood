/** Automatic metadata probing and explicit load ownership (PRD §13; docs/design/landing.md). */
import assert from "node:assert/strict";
import test from "node:test";
import { LandingScene } from "../landing-scene.mjs";
import { SpriteBank } from "../sprite-bank.mjs";
import { fetchSpriteMetadata } from "./fixtures/sprite-fetch.mjs";

const clip = { fps: 24, pages: [{ file: "0.webp" }], frames: [{ page: 0, x: 0, y: 0, w: 1, h: 1, anchor: { x: 0, y: 0 }, socket: { x: 0, y: 0 } }] };
const settle = () => new Promise((resolve) => setImmediate(resolve));
function fixture(t) {
  const original = { fetch: globalThis.fetch, Image: globalThis.Image, document: globalThis.document, matchMedia: globalThis.matchMedia };
  t.after(() => Object.assign(globalThis, original));
  const errors = [];
  const bank = new SpriteBank((error) => errors.push(error));
  fetchSpriteMetadata(async () => new Response(JSON.stringify(clip)));
  globalThis.Image = class { async decode() {} };
  return { bank, errors };
}

for (const stage of ["metadata", "page"]) {
  for (const first of ["explicit", "automatic"]) {
    test(`${stage} failure reports once when ${first} preparation starts first`, async (t) => {
      const { bank, errors } = fixture(t);
      const gate = Promise.withResolvers();
      let calls = 0;
      if (stage === "metadata") fetchSpriteMetadata(() => { calls++; return gate.promise; });
      else {
        bank.clips.set("wave", clip);
        globalThis.Image = class { decode() { calls++; return gate.promise; } };
      }
      const automatic = () => { for (let i = 0; i < 1000; i++) bank.frame("wave", 0); };
      if (first === "automatic") { automatic(); await settle(); }
      const explicit = bank.prepare("wave").catch((error) => errors.push(error));
      await settle();
      automatic();
      await settle();
      gate.reject(new Error("unavailable asset"));
      await explicit;
      await settle();
      assert.equal(calls, 1);
      assert.equal(errors.length, 1);
      automatic();
      await settle();
      assert.equal(calls, 1);
      assert.equal(errors.length, 1);
    });
  }
}

test("automatic landing fit probes latch failed metadata and never decode entry sheets", async (t) => {
  fixture(t);
  const context = new Proxy({}, { get: () => () => {} });
  const canvas = () => ({ getContext: () => context });
  globalThis.document = { createElement: canvas };
  globalThis.matchMedia = () => ({ matches: false });
  const errors = [];
  const scene = new LandingScene(canvas(), { onError: (error) => errors.push(error) });
  scene.world.clips.wave = {};
  let requests = 0;
  let decoded = 0;
  fetchSpriteMetadata(async () => { requests++; return new Response("", { status: 503 }); });
  globalThis.Image = class { async decode() { decoded++; } };
  for (let batch = 0; batch < 5; batch++) {
    for (let i = 0; i < 1000; i++) assert.equal(scene.performanceFits("wave"), null);
    await settle();
  }
  assert.equal(requests, 1);
  assert.equal(errors.length, 1);
  assert.equal(decoded, 0);
  fetchSpriteMetadata(async () => { requests++; return new Response(JSON.stringify(clip)); });
  await scene.bank.prepare("wave");
  assert.equal(typeof scene.performanceFits("wave"), "boolean");
  assert.equal(requests, 2);
  assert.equal(decoded, 1);
  // A new successful fit probe also stays metadata-only.
  scene.world.clips.bow = {};
  assert.equal(scene.performanceFits("bow"), null);
  await settle();
  assert.equal(typeof scene.performanceFits("bow"), "boolean");
  assert.equal(requests, 3);
  assert.equal(decoded, 1);
});
