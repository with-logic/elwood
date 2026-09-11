// Optional CPU rendering check. Pass the path to @napi-rs/canvas; never loaded by the site.

import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { LandingScene } from "../landing-scene.mjs";
import { socketPosition } from "../sprite-pose.mjs";

const { createCanvas, Image } = createRequire(import.meta.url)(
  process.argv[2] || "@napi-rs/canvas",
);
const root = new URL("../", import.meta.url);
const unit = 136 / 384;
globalThis.document = { createElement: () => createCanvas(1, 1) };
globalThis.matchMedia = () => ({ matches: false });
globalThis.devicePixelRatio = 1;
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};
globalThis.fetch = async (url) => new Response(await readFile(new URL(String(url), root)));
globalThis.Image = class extends Image {
  set src(value) {
    this.location = value;
  }
  async decode() {
    const bytes = await readFile(new URL(this.location, root));
    await new Promise((resolve, reject) => {
      this.onload = resolve;
      this.onerror = reject;
      super.src = bytes;
    });
  }
};
const canvas = createCanvas(600, 600);
const scene = new LandingScene(canvas);
const config = {
  width: 600,
  height: 600,
  scale: 2,
  floorY: 510,
  robotX: 300,
  terminal: { x: 300, y: 45 },
  platforms: [],
  side: false,
};
await scene.boot();
scene.configure(config, true);
const sheet = createCanvas(1800, 1800);
const c = sheet.getContext("2d");
c.fillStyle = "#fbf6e7";
c.fillRect(0, 0, sheet.width, sheet.height);
async function readyPose() {
  const p = scene.world.player;
  const clip = await scene.bank.load(p.animation);
  const index = scene.dragging
    ? Math.floor(p.animationTime * clip.fps) % clip.frames.length
    : scene.world.frameIndex(clip.frames.length);
  await scene.bank.loadPage(p.animation, clip.frames[index].page);
}
async function shot(index, label) {
  await readyPose();
  scene.paint(0);
  scene.world.time += 0.1;
  scene.paint(0.1);
  c.drawImage(canvas, (index % 3) * 600, Math.floor(index / 3) * 600);
  c.fillStyle = "#171916";
  c.font = "16px sans-serif";
  c.fillText(`${label} — CPU canvas`, (index % 3) * 600 + 24, Math.floor(index / 3) * 600 + 580);
}
await shot(0, "Idle / size reference");
scene.world.animate("run", true);
scene.world.player.walkPhase = 0;
await shot(1, "Sprint / stride A");
scene.world.player.walkPhase = 7;
await shot(2, "Sprint / stride B");
scene.configure(config, true);
await scene.bank.prepare("pickup-wriggle");
scene.beginDrag({ x: 150, y: 540 });
scene.moveDrag({ x: 150, y: 460 });
const clip = scene.bank.clips.get("pickup-wriggle");
let _checked = 0;
for (const facing of [-1, 1]) {
  scene.world.player.facing = facing;
  for (let frame = 0; frame < clip.frames.length; frame++) {
    scene.world.player.animationTime = (frame + 0.001) / clip.fps;
    const fallback = socketPosition(scene.pose(), unit);
    assert.ok(
      Math.hypot(fallback.x - scene.drag.socket.x, fallback.y - scene.drag.socket.y) < 1e-8,
    );
    await scene.bank.loadPage(clip.name, clip.frames[frame].page);
    const socket = socketPosition(scene.pose(), unit);
    assert.ok(Math.hypot(socket.x - scene.drag.socket.x, socket.y - scene.drag.socket.y) < 1e-8);
    assert.ok(scene.bank.pages.size <= 4);
    _checked++;
  }
}
scene.world.player.facing = 1;
for (const [i, frame] of [0, 48, 96].entries()) {
  scene.world.player.animationTime = frame / clip.fps;
  await shot(3 + i, `Wriggle / frame ${frame}`);
}
await scene.bank.prepare("pickup-fall");
const before = socketPosition(scene.pose(), unit);
scene.endDrag();
const after = socketPosition(scene.pose(), unit);
assert.ok(Math.hypot(after.x - before.x, after.y - before.y) < 1e-8);
await shot(6, "Released / falling");
for (let i = 0; i < 200 && scene.world.player.mode === "air"; i++) scene.step(1 / 120);
assert.equal(scene.world.player.gesture, "hero-land");
for (let i = 0; i < 40; i++) {
  await readyPose();
  scene.step(1 / 120);
}
await shot(7, "Three-point landing");
for (let i = 0; i < 480 && scene.world.player.gesture; i++) {
  await readyPose();
  scene.step(1 / 120);
}
assert.equal(scene.world.player.gesture, null);
await shot(8, "Recovered / retained orientation");
await writeFile(new URL("docs/reviews/new-motions.png", root), sheet.toBuffer("image/png"));
