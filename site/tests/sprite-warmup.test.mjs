/** Clips load ahead of use without changing who owns or reports them (PRD §13.5, C-SITE-06). */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { bindPickupIntent, DECODED_AHEAD, DOWNLOADED_AHEAD, warmLanding } from "../landing/warmup.mjs";
import { DECODED_SHEET_BYTES, decodedClipBytes, limitsFor, spriteLimits } from "../sprite-limits.mjs";
import { fixture, turn, waitFor } from "./animation-fixture.mjs";
import { automaticScene } from "./automatic-scene-fixture.mjs";

const settle = async () => { for (let i = 0; i < 20; i++) await turn(); };
const count = (requested, path) => requested.filter((entry) => entry === path).length;
// Fixture pages carry no dimensions, so each is charged as one full sheet.
function cacheHolding(t, sheets) {
  const original = spriteLimits.cacheLimitBytes;
  t.after(() => { spriteLimits.cacheLimitBytes = original; });
  spriteLimits.cacheLimitBytes = sheets * DECODED_SHEET_BYTES;
}
const shipped = async (path) => JSON.parse(await readFile(new URL(`../assets/game/${path}`, import.meta.url), "utf8"));

test("C-SITE-06 loading ahead decodes every page of a clip once and later frames need no request", async (t) => {
  const { bank, requested, errors } = fixture(t);
  const [first, second] = await Promise.all([bank.loadAhead("bow"), bank.loadAhead("bow")]);
  assert.equal(first, 2 * DECODED_SHEET_BYTES);
  assert.equal(second, first);
  assert.equal(await bank.loadAhead("bow"), first);
  assert.deepEqual(requested.toSorted(), ["bow/0.webp", "bow/1.webp", "bow/clip.json"]);
  assert.ok(bank.frame("bow", 0));
  assert.ok(bank.frame("bow", 1));
  assert.equal(requested.length, 3);
  assert.deepEqual(errors, []);
});

test("C-SITE-06 pages loaded ahead hold no lease and leave the cache like any other page", async (t) => {
  cacheHolding(t, 4);
  const { bank, images } = fixture(t);
  await bank.loadAhead("bow");
  const ahead = images.filter((image) => image.path.startsWith("bow/"));
  assert.equal(ahead.length, 2);
  for (let i = 0; i < 6; i++) await bank.loadPage("wave", i);
  assert.deepEqual(ahead.map((image) => image.closed), [1, 1]);
});

test("C-SITE-06 a clip that is declined loads only its metadata", async (t) => {
  const { bank, requested } = fixture(t);
  const sizes = [];
  assert.equal(await bank.loadAhead("wave", (bytes) => { sizes.push(bytes); return false; }), 0);
  assert.deepEqual(sizes, [6 * DECODED_SHEET_BYTES]);
  assert.deepEqual(requested, ["wave/clip.json"]);
});

test("C-SITE-06 loading ahead shares its requests with complete preparation", async (t) => {
  const { bank, requested, gates } = fixture(t);
  const gate = Promise.withResolvers();
  gates.set("wave/5.webp", gate);
  const ahead = bank.loadAhead("wave");
  await waitFor(requested, "wave/5.webp");
  const prepared = bank.prepareAnimation("wave");
  await settle();
  gate.resolve();
  assert.ok(await prepared);
  assert.equal(await ahead, 6 * DECODED_SHEET_BYTES);
  for (let page = 0; page < 6; page++) assert.equal(count(requested, `wave/${page}.webp`), 1);
});

for (const stage of ["clip.json", "1.webp"]) {
  test(`C-SITE-06 a failed ${stage} loaded ahead reports nothing and first real use retries it`, async (t) => {
    const { bank, requested, gates, errors } = fixture(t);
    const gate = Promise.withResolvers();
    gates.set(`bow/${stage}`, gate);
    const ahead = bank.loadAhead("bow");
    await waitFor(requested, `bow/${stage}`);
    gate.reject(new Error("unavailable asset"));
    assert.equal(await ahead, 0);
    assert.deepEqual(errors, []);
    assert.equal(bank.hasAnimationFailure("bow"), false, "no failure latch suppresses automatic use");
    gates.delete(`bow/${stage}`);
    // A paint asks for the clip: an ordinary automatic load, free to try again.
    for (let i = 0; i < 20 && !bank.frame("bow", 1); i++) await turn();
    assert.ok(bank.frame("bow", 1));
    assert.equal(count(requested, `bow/${stage}`), 2);
    assert.deepEqual(errors, []);
  });
}

test("C-SITE-06 a failure shared with a paint still reports once and is not retried", async (t) => {
  const { bank, requested, gates, errors } = fixture(t);
  await bank.load("bow");
  const gate = Promise.withResolvers();
  gates.set("bow/0.webp", gate);
  const ahead = bank.loadAhead("bow");
  await waitFor(requested, "bow/0.webp");
  assert.equal(bank.frame("bow", 0), null);
  gate.reject(new Error("unavailable asset"));
  assert.equal(await ahead, 0);
  await settle();
  assert.equal(errors.length, 1);
  for (let i = 0; i < 20; i++) bank.frame("bow", 0);
  await settle();
  assert.equal(count(requested, "bow/0.webp"), 1);
  assert.equal(errors.length, 1);
});

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

test("C-SITE-06 loading ahead never outgrows the cache beside idle and the clips kept from the handoff", async (t) => {
  cacheHolding(t, 5);
  const { scene, requested } = await automaticScene(t);
  scene.keptBytes = 2 * DECODED_SHEET_BYTES;
  await scene.warm(["bow", "wave", "cartwheel"], { keep: true });
  assert.ok(requested.includes("bow/1.webp"), "two sheets fit beside idle");
  assert.deepEqual(requested.filter((path) => path.startsWith("wave/")), ["wave/clip.json"], "six sheets do not");
  assert.deepEqual(requested.filter((path) => path.startsWith("cartwheel/")), ["cartwheel/clip.json"], "nor two more after bow is kept");
  assert.equal(scene.keptBytes, 4 * DECODED_SHEET_BYTES);
  scene.keptBytes = 2 * DECODED_SHEET_BYTES;
  await scene.warm(["cartwheel"]);
  assert.ok(requested.includes("cartwheel/1.webp"));
  assert.equal(scene.keptBytes, 2 * DECODED_SHEET_BYTES, "a hover decode is not kept");
});

test("C-SITE-06 the clips loaded ahead are the ones the specification names, and all are shipped", async () => {
  assert.deepEqual([...DECODED_AHEAD].toSorted(),
    ["idle-left", "idle-right", "jump", "land", "land-rest", "rotation", "walk-left", "walk-right"]);
  assert.deepEqual([...DOWNLOADED_AHEAD].toSorted(),
    ["hero-land", "idle-back", "idle-front", "pickup-fall", "pickup-wriggle", "run"]);
  const manifest = await shipped("manifest.json");
  for (const name of [...DECODED_AHEAD, ...DOWNLOADED_AHEAD]) assert.ok(manifest.clips[name], `${name} is in the manifest`);
  assert.throws(() => DECODED_AHEAD.push("wave"), TypeError);
  assert.throws(() => DOWNLOADED_AHEAD.push("wave"), TypeError);
});

test("C-SITE-06 the shipped sheets fit the cache they are decoded into on both memory tiers", async () => {
  const size = async (name) => decodedClipBytes(await shipped(`${name}/clip.json`));
  const kept = async (limit) => {
    let bytes = await size("idle");
    const names = [];
    for (const name of DECODED_AHEAD) {
      const clip = await size(name);
      if (bytes + clip > limit) continue;
      bytes += clip;
      names.push(name);
    }
    return { bytes, names };
  };
  const wriggle = await size("pickup-wriggle");
  const full = await kept(limitsFor({ deviceMemory: 8 }).cacheLimitBytes);
  assert.deepEqual(full.names, [...DECODED_AHEAD], "twelve sheets keep every movement clip");
  assert.ok(full.bytes + wriggle <= limitsFor({ deviceMemory: 8 }).cacheLimitBytes, "and the hovered pickup beside them");
  const low = await kept(limitsFor({ deviceMemory: 4 }).cacheLimitBytes);
  assert.deepEqual(low.names, DECODED_AHEAD.filter((name) => name !== "jump"), "six sheets keep all but the jump");
  assert.ok(low.bytes + wriggle > limitsFor({ deviceMemory: 4 }).cacheLimitBytes, "and leave the pickup to decode on the press");
});

function landing(t, { clips = [...DECODED_AHEAD, ...DOWNLOADED_AHEAD], reduced = false, respond } = {}) {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const fetched = [];
  const frame = { page: 0, x: 0, y: 0, w: 1, h: 1, anchor: { x: 0, y: 0 }, socket: { x: 0, y: 0 } };
  globalThis.fetch = async (url, options) => {
    const path = new URL(url).pathname.split("/game/").at(-1);
    // An aborted request never reaches the network.
    options.signal.throwIfAborted();
    fetched.push({ path, options });
    const custom = await respond?.(path);
    if (custom) return custom;
    return path.endsWith("clip.json")
      ? Response.json({ fps: 24, pages: [{ file: "page-000.webp" }, { file: "page-001.webp" }], frames: [frame] })
      : new Response("sheet");
  };
  const warmed = [];
  const scene = { reduced, world: { clips: Object.fromEntries(clips.map((name) => [name, {}])) }, warm: (...args) => warmed.push(args) };
  return { scene, warmed, fetched, paths: () => fetched.map((entry) => entry.path) };
}

test("C-SITE-06 the handoff decodes and keeps the movement clips and downloads the rest in order at low priority", async (t) => {
  const { scene, warmed, fetched, paths } = landing(t);
  warmLanding(scene, undefined);
  await settle();
  await settle();
  assert.deepEqual(warmed, [[DECODED_AHEAD, { keep: true }]]);
  assert.deepEqual(paths(), DOWNLOADED_AHEAD.flatMap((name) => [`${name}/clip.json`, `${name}/page-000.webp`, `${name}/page-001.webp`]));
  assert.ok(fetched.every((entry) => entry.options.priority === "low"));
});

for (const [reason, options, connection] of [
  ["a data-saving connection", {}, { saveData: true }],
  ["reduced motion", { reduced: true }, undefined],
]) {
  test(`C-SITE-06 ${reason} loads nothing ahead of use at the handoff`, async (t) => {
    const { scene, warmed, fetched } = landing(t, options);
    warmLanding(scene, connection);
    await settle();
    assert.deepEqual(warmed, []);
    assert.deepEqual(fetched, []);
  });
}

test("C-SITE-06 downloads skip unshipped clips and stop a clip at its first failed, missing or invalid file", async (t) => {
  const { scene, paths } = landing(t, {
    clips: ["pickup-wriggle", "hero-land", "pickup-fall", "run", "idle-front"],
    respond: (path) => {
      if (path === "pickup-wriggle/page-000.webp") throw new Error("offline");
      if (path === "hero-land/clip.json") return new Response("missing", { status: 404 });
      if (path === "pickup-fall/page-000.webp") return new Response("missing", { status: 404 });
      if (path === "run/clip.json") return Response.json({ pages: [{ file: "page-000.webp" }] });
    },
  });
  warmLanding(scene, {});
  await settle();
  await settle();
  assert.deepEqual(paths(), [
    "pickup-wriggle/clip.json", "pickup-wriggle/page-000.webp",
    "hero-land/clip.json",
    "pickup-fall/clip.json", "pickup-fall/page-000.webp",
    "run/clip.json",
    "idle-front/clip.json", "idle-front/page-000.webp", "idle-front/page-001.webp",
  ]);
});

test("C-SITE-06 aborting stops further downloads", async (t) => {
  const gate = Promise.withResolvers();
  const { scene, paths } = landing(t, { respond: (path) => path === "pickup-wriggle/page-000.webp" ? gate.promise : undefined });
  const controller = warmLanding(scene, {});
  await settle();
  controller.abort();
  gate.resolve(new Response("sheet"));
  await settle();
  assert.deepEqual(paths(), ["pickup-wriggle/clip.json", "pickup-wriggle/page-000.webp"]);
});
