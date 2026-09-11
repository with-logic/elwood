// Optional CPU raster checks; no dependency is loaded by the browser game.
// node scripts/verify_sprite_blends.mjs /path/to/node_modules/@napi-rs/canvas

import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { blendAtSocket, positionPose } from "../sprite-pose.mjs";
import { SpriteRenderer } from "../sprite-renderer.mjs";

const { createCanvas, loadImage } = createRequire(import.meta.url)(
  process.argv[2] || "@napi-rs/canvas",
);
const root = new URL("../", import.meta.url);
const pixels = (canvas) =>
  canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
const makeRenderer = (canvas) => new SpriteRenderer(canvas.getContext("2d"), createCanvas(1, 1));

function coloredPose(color, x = 20, mirrored = false) {
  const page = createCanvas(16, 16);
  const context = page.getContext("2d");
  context.fillStyle = color;
  context.fillRect(2, 2, 10, 12);
  context.fillStyle = "#74a9cc80";
  context.fillRect(12, 2, 2, 12);
  return { x, y: 24, mirrored, page, frame: { x: 0, y: 0, w: 16, h: 16, anchor: { x: 8, y: 16 } } };
}

test("opaque robot pixels stay opaque and keep their color at every blend weight", () => {
  const pose = coloredPose("#203040");
  const canvas = createCanvas(40, 40);
  const context = canvas.getContext("2d");
  const renderer = makeRenderer(canvas);
  for (const blend of [0.1, 0.25, 0.5, 0.75, 0.9]) {
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, 40, 40);
    renderer.draw(pose, pose, blend, 1);
    const rgba = [...context.getImageData(18, 16, 1, 1).data];
    [32, 48, 64, 255].forEach((expected, i) =>
      assert.ok(Math.abs(rgba[i] - expected) <= 1, `Blend ${blend}: ${rgba}`),
    );
  }
});

// Compare against a pixel-wise interpolation of independently rendered poses.
// This checks transparent edges, unequal silhouettes and their entire bounds,
// including mirroring, Retina scaling and fractional camera translation.
function verifyBlend(incoming, outgoing, scale, density, offsetX, offsetY, blend) {
  function render(a, b, weight) {
    const canvas = createCanvas(420, 420);
    canvas.getContext("2d").setTransform(density, 0, 0, density, offsetX, offsetY);
    makeRenderer(canvas).draw(a, b, weight, scale, density);
    return pixels(canvas);
  }
  const actual = render(incoming, outgoing, blend);
  const start = render(outgoing, null, 1);
  const end = render(incoming, null, 1);
  let checked = 0;
  for (let i = 0; i < actual.length; i += 4) {
    const alpha = start[i + 3] * (1 - blend) + end[i + 3] * blend;
    assert.ok(
      Math.abs(actual[i + 3] - alpha) <= 2,
      `Alpha at pixel ${i / 4}: ${actual[i + 3]} vs ${alpha}`,
    );
    if (alpha > 0) checked++;
    for (let channel = 0; channel < 3; channel++) {
      const expected =
        (start[i + channel] * start[i + 3] * (1 - blend) + end[i + channel] * end[i + 3] * blend) /
        255;
      const observed = (actual[i + channel] * actual[i + 3]) / 255;
      assert.ok(
        Math.abs(observed - expected) <= 2,
        `Premultiplied channel at pixel ${i / 4}: ${observed} vs ${expected}`,
      );
    }
  }
  assert.ok(checked > 50, "The check must include visible sprite pixels");
}

test("different silhouettes and translucent edges blend correctly at varied scales and camera offsets", () => {
  for (const mirrored of [false, true]) {
    for (const density of [1, 2, 1.8055555556]) {
      verifyBlend(
        coloredPose("#b42e52", 24, mirrored),
        coloredPose("#203040", 20, !mirrored),
        1,
        density,
        -0.37,
        0.23,
        0.5,
      );
    }
  }
});

test("the blend buffer is reused and cleared between unrelated poses and direct draws", () => {
  const canvas = createCanvas(40, 40);
  const context = canvas.getContext("2d");
  const renderer = makeRenderer(canvas);
  const pose = coloredPose("#203040");
  for (const blend of [0.25, 1, 0, 0.75, 0.5]) {
    context.clearRect(0, 0, 40, 40);
    renderer.draw(pose, pose, blend, 1);
    const expected = createCanvas(40, 40);
    makeRenderer(expected).draw(pose, pose, blend, 1);
    assert.deepEqual(pixels(canvas), pixels(expected));
  }
  assert.ok(
    renderer.canvas.width <= 64 && renderer.canvas.height <= 64,
    "Scratch space stays local to the character",
  );
});

async function assetPose(name, frameIndex = 0, facing = 1) {
  const clip = JSON.parse(await readFile(new URL(`assets/game/${name}/clip.json`, root)));
  const frame = clip.frames[frameIndex];
  const page = await loadImage(
    fileURLToPath(new URL(`assets/game/${name}/${clip.pages[frame.page].file}`, root)),
  );
  return positionPose({ clip, frame, page }, { x: 120, y: 200, facing });
}

test("real front/back/gesture assets preserve coverage throughout connector-aligned transitions", async () => {
  const front = await assetPose("idle-front");
  const back = await assetPose("idle-back");
  const thinking = await assetPose("thinking", 0, -1);
  for (const [incoming, outgoing] of [
    [front, front],
    [front, back],
    [thinking, front],
  ]) {
    for (const blend of [0.25, 0.5, 0.75]) {
      const display = blendAtSocket(incoming, outgoing, blend, 136 / 384);
      verifyBlend(display.incoming, display.outgoing, 136 / 384, 1.8055555556, -0.37, 0.23, blend);
    }
  }

  // A viewable reproduction of the white-flash defect, using the exact front
  // image shared by the turn endpoint and the camera-facing resting stance.
  const sheet = createCanvas(900, 410);
  const context = sheet.getContext("2d");
  context.fillStyle = "#f6f8fa";
  context.fillRect(0, 0, sheet.width, sheet.height);
  context.fillStyle = "#23313b";
  context.font = "18px sans-serif";
  const labels = ["Original frame", "Old midpoint: pale flash", "Fixed midpoint"];
  labels.forEach((label, i) => context.fillText(label, i * 300 + 25, 36));
  const pose = { ...front, x: 150, y: 365 };
  makeRenderer(sheet).draw(pose, null, 1, 0.75);
  const single = createCanvas(300, 410);
  makeRenderer(single).draw(pose, null, 1, 0.75);
  context.globalAlpha = 0.5;
  context.drawImage(single, 300, 0);
  context.drawImage(single, 300, 0);
  context.globalAlpha = 1;
  makeRenderer(sheet).draw({ ...pose, x: 750 }, { ...pose, x: 750 }, 0.5, 0.75);
  await writeFile(new URL("docs/reviews/transition-blends.png", root), sheet.toBuffer("image/png"));
});
