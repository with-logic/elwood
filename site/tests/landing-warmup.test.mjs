/** The landing page loads its first-reached clips ahead of use (PRD §13.5, C-SITE-06). */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { DECODED_AHEAD, DOWNLOADED_AHEAD, warmLanding } from "../landing/warmup.mjs";
import { SpriteDownloads } from "../sprite-downloads.mjs";
import { decodedClipBytes, limitsFor } from "../sprite-limits.mjs";
import { turn } from "./animation-fixture.mjs";

const settle = async () => { for (let i = 0; i < 20; i++) await turn(); };
const shipped = async (path) => JSON.parse(await readFile(new URL(`../assets/game/${path}`, import.meta.url), "utf8"));
// The twelve-byte header every WebP file starts with.
const WEBP = new TextEncoder().encode("RIFF\0\0\0\0WEBP");

test("C-SITE-06 the clips loaded ahead are the ones the specification names, and all are shipped", async () => {
  assert.deepEqual([...DECODED_AHEAD],
    ["rotation", "walk-right", "walk-left", "idle-right", "idle-left", "land", "land-rest", "jump"]);
  assert.deepEqual([...DOWNLOADED_AHEAD],
    ["pickup-wriggle", "hero-land", "pickup-fall", "run", "idle-front", "idle-back"]);
  const manifest = await shipped("manifest.json");
  for (const name of [...DECODED_AHEAD, ...DOWNLOADED_AHEAD]) assert.ok(manifest.clips[name], `${name} is in the manifest`);
  assert.throws(() => DECODED_AHEAD.push("wave"), TypeError);
  assert.throws(() => DOWNLOADED_AHEAD.push("wave"), TypeError);
});

test("C-SITE-06 the shipped sheets fit the cache they are decoded into on both memory tiers", async () => {
  const clipBytes = async (name) => decodedClipBytes(await shipped(`${name}/clip.json`));
  const kept = async (cacheLimitBytes) => {
    let bytes = await clipBytes("idle");
    const names = [];
    for (const name of DECODED_AHEAD) {
      const candidateBytes = await clipBytes(name);
      if (bytes + candidateBytes > cacheLimitBytes) continue;
      bytes += candidateBytes;
      names.push(name);
    }
    return { bytes, names };
  };
  const pickupWriggleBytes = await clipBytes("pickup-wriggle");
  const full = await kept(limitsFor({ deviceMemory: 8 }).cacheLimitBytes);
  assert.deepEqual(full.names, [...DECODED_AHEAD], "twelve sheets keep every movement clip");
  assert.ok(full.bytes + pickupWriggleBytes <= limitsFor({ deviceMemory: 8 }).cacheLimitBytes, "and the hovered pickup beside them");
  const low = await kept(limitsFor({ deviceMemory: 4 }).cacheLimitBytes);
  assert.deepEqual(low.names, DECODED_AHEAD.filter((name) => name !== "jump"), "six sheets keep all but the jump");
  assert.ok(low.bytes + pickupWriggleBytes > limitsFor({ deviceMemory: 4 }).cacheLimitBytes, "and leave the pickup to decode on the press");
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
      : new Response(WEBP);
  };
  const warmed = [];
  const downloads = new SpriteDownloads();
  const scene = { reduced, bank: { downloads }, world: { clips: Object.fromEntries(clips.map((name) => [name, {}])) }, warm: (...args) => warmed.push(args) };
  return { scene, warmed, fetched, downloads, paths: () => fetched.map((entry) => entry.path) };
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
  const { scene, paths, downloads } = landing(t, {
    clips: ["pickup-wriggle", "hero-land", "pickup-fall", "run", "idle-front", "idle-back"],
    respond: (path) => {
      if (path === "pickup-wriggle/page-000.webp") throw new Error("offline");
      if (path === "hero-land/clip.json") return new Response("missing", { status: 404 });
      if (path === "pickup-fall/page-000.webp") return new Response("missing", { status: 404 });
      if (path === "run/clip.json") return Response.json({ pages: [{ file: "page-000.webp" }] });
      if (path === "idle-front/page-000.webp") return new Response("<html>an error page served with 200</html>");
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
    "idle-front/clip.json", "idle-front/page-000.webp",
    "idle-back/clip.json", "idle-back/page-000.webp", "idle-back/page-001.webp",
  ]);
  assert.equal(downloads.sheet("idle-front/page-000.webp"), undefined, "a file that is not a WebP is not held");
  assert.equal(downloads.clip("run"), undefined);
  assert.equal((await downloads.sheet("idle-back/page-001.webp").arrayBuffer()).byteLength, WEBP.byteLength);
  assert.deepEqual(Object.keys(downloads.clip("idle-back")), ["fps", "pages", "frames"]);
});

test("C-SITE-06 aborting stops further downloads", async (t) => {
  const gate = Promise.withResolvers();
  const { scene, paths } = landing(t, { respond: (path) => path === "pickup-wriggle/page-000.webp" ? gate.promise : undefined });
  const controller = warmLanding(scene, {});
  await settle();
  controller.abort();
  gate.resolve(new Response(WEBP));
  await settle();
  assert.deepEqual(paths(), ["pickup-wriggle/clip.json", "pickup-wriggle/page-000.webp"]);
});

test("C-SITE-06 held files are dropped when the bank closes, and a download in flight holds nothing", async (t) => {
  const gate = Promise.withResolvers();
  const { scene, downloads } = landing(t, { respond: (path) => path === "hero-land/clip.json" ? gate.promise : undefined });
  warmLanding(scene, {});
  await settle();
  assert.ok(downloads.sheet("pickup-wriggle/page-001.webp"));
  downloads.release("pickup-wriggle/page-001.webp");
  assert.equal(downloads.sheet("pickup-wriggle/page-001.webp"), undefined);
  downloads.close();
  // Releasing the gate lets the fixture answer with its ordinary valid clip.
  gate.resolve();
  await settle();
  assert.equal(downloads.clip("pickup-wriggle"), undefined);
  assert.equal(downloads.sheet("pickup-wriggle/page-000.webp"), undefined);
  assert.equal(downloads.clip("hero-land"), undefined);
});
