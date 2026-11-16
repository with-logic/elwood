/** The landing scene decodes clips ahead of use within its cache budget (PRD §13.5, C-SITE-06). */
import assert from "node:assert/strict";
import test from "node:test";
import { bindPickupIntent } from "../landing/warmup.mjs";
import { DECODED_SHEET_BYTES, spriteLimits } from "../sprite-limits.mjs";
import { turn, waitFor } from "./animation-fixture.mjs";
import { automaticScene } from "./automatic-scene-fixture.mjs";

const settle = async () => { for (let i = 0; i < 20; i++) await turn(); };
const count = (requested, path) => requested.filter((entry) => entry === path).length;
// Fixture pages carry no dimensions, so each is charged as one full sheet.
function cacheHolding(t, sheets) {
  const original = spriteLimits.cacheLimitBytes;
  t.after(() => { spriteLimits.cacheLimitBytes = original; });
  spriteLimits.cacheLimitBytes = sheets * DECODED_SHEET_BYTES;
}

test("C-SITE-06 hover decodes the suspended pickup clip only, and the press needs no further request for it", async (t) => {
  const { scene, requested, errors } = await automaticScene(t, (name) => name === "pickup-wriggle" ? 4 : 1);
  for (const name of ["pickup-wriggle", "pickup-fall", "hero-land"]) scene.world.clips[name] = { frames: 4, fps: 24 };
  scene.lastPose = scene.pose();
  const grip = new EventTarget();
  bindPickupIntent(scene, grip);
  grip.dispatchEvent(new Event("pointerenter"));
  await settle();
  for (let page = 0; page < 4; page++) assert.ok(scene.bank.pages.has(`pickup-wriggle/${page}`));
  assert.equal(requested.some((path) => path.startsWith("hero-land") || path.startsWith("pickup-fall")), false,
    "the fall and landing wait for the drag");
  const before = requested.filter((path) => path.startsWith("pickup-wriggle")).length;
  assert.equal(scene.beginDrag({ x: 300, y: 400 }), true);
  await settle();
  assert.equal(scene.world.player.animation, "pickup-wriggle");
  assert.equal(requested.filter((path) => path.startsWith("pickup-wriggle")).length, before);
  assert.ok(requested.includes("hero-land/0.webp"));
  assert.deepEqual(errors, []);
});

test("C-SITE-06 focus decodes the fallback clip when the dedicated pickup footage is absent", async (t) => {
  const { scene, requested } = await automaticScene(t);
  assert.deepEqual(scene.pickupClips(), { suspended: "zero-gravity", release: ["land"] });
  scene.world.clips["zero-gravity"] = { frames: 2, fps: 24 };
  const grip = new EventTarget();
  bindPickupIntent(scene, grip);
  grip.dispatchEvent(new Event("focus"));
  await settle();
  assert.ok(requested.includes("zero-gravity/0.webp"));
  assert.ok(requested.includes("zero-gravity/1.webp"));
  Object.assign(scene.world.clips, { "pickup-wriggle": {}, "hero-land": {} });
  assert.deepEqual(scene.pickupClips(), { suspended: "pickup-wriggle", release: ["hero-land", "pickup-fall"] });
});

test("C-SITE-06 scene loading ahead skips unknown clips and waits for readiness", async (t) => {
  const { scene, requested } = await automaticScene(t);
  const before = requested.length;
  scene.ready = false;
  await scene.warm(["wave"]);
  scene.ready = true;
  await scene.warm(["not-shipped"]);
  assert.equal(requested.length, before);
  await scene.warm(["wave"]);
  assert.equal(requested.length, before + 7);
});

test("C-SITE-06 clips load ahead one at a time, and a repeated request joins the one in flight", async (t) => {
  const { scene, requested, gates } = await automaticScene(t);
  const gate = Promise.withResolvers();
  gates.set("bow/1.webp", gate);
  const first = scene.warm(["bow", "wave"]);
  await waitFor(requested, "bow/1.webp");
  const repeated = scene.warm(["bow"]);
  await settle();
  assert.equal(requested.some((path) => path.startsWith("wave/")), false, "the next clip waits for this one");
  assert.equal(count(requested, "bow/clip.json"), 1);
  gate.resolve();
  await Promise.all([first, repeated]);
  assert.ok(requested.includes("wave/5.webp"));
});

test("C-SITE-06 loading ahead declines what does not fit and leaves idle and the kept clips cached", async (t) => {
  cacheHolding(t, 5);
  const { scene, requested } = await automaticScene(t);
  const cached = (name) => [...scene.bank.pages.keys()].filter((key) => key.startsWith(`${name}/`)).length;
  // Idle's entry sheet is what the handoff leaves behind.
  scene.keptBytes = DECODED_SHEET_BYTES;
  assert.equal(cached("idle"), 1);
  await scene.warm(["bow", "wave"], { keep: true });
  assert.equal(cached("bow"), 2, "two sheets fit beside idle");
  assert.deepEqual(requested.filter((path) => path.startsWith("wave/")), ["wave/clip.json"], "six sheets do not");
  assert.equal(scene.keptBytes, 3 * DECODED_SHEET_BYTES);
  await scene.warm(["cartwheel"]);
  assert.deepEqual(["idle", "bow", "cartwheel"].map(cached), [1, 2, 2], "a hover decode fills the cache without evicting the kept set");
  assert.equal(scene.keptBytes, 3 * DECODED_SHEET_BYTES, "and is not itself kept");
  scene.keptBytes = 4 * DECODED_SHEET_BYTES;
  await scene.warm(["rotation"]);
  assert.deepEqual(requested.filter((path) => path.startsWith("rotation/")), ["rotation/clip.json"], "a clip that would overflow is declined");
  assert.deepEqual(["idle", "bow"].map(cached), [1, 2]);
});
