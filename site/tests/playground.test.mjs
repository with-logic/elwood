import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  blendAtSocket,
  positionPose,
  samePoseImage,
  socketPosition,
  transitionPose,
} from "../sprite-pose.mjs";
import { HEIGHT, World } from "../world.mjs";

// Exercise the actual page module and input handlers without claiming browser
// layout/painting coverage. The canvas spy checks finite drawing coordinates;
// JSON and image bytes come from the real generated files.
const root = new URL("../", import.meta.url);

// The 4K production masters are the asset pipeline's inputs and are NOT part of
// the deployed site or this repository (see .gitignore). Tests that verify an
// exported sprite against its master therefore run only in a checkout that has
// them; everywhere else they skip instead of failing on a missing file.
const masterTest = existsSync(new URL("assets/production/", root)) ? test : test.skip;

const listeners = new Map();
const documentListeners = new Map();
const elements = new Map();
let pendingFrame = null;
let now = 0;
let drawnImage = "";
const idleFrames = new Set();
function canvasContext() {
  return new Proxy(
    {
      measureText: () => ({ width: 220, actualBoundingBoxAscent: 220 }),
      getTransform: () => ({ e: 0, f: 0 }),
      drawImage(image, ...numbers) {
        assert.ok(!image.closed, "A rendered sprite must still be owned");
        assert.ok(numbers.every(Number.isFinite), "Canvas coordinates must be finite");
        if (image.src) {
          drawnImage = image.src;
          if (image.src.includes("/idle/"))
            idleFrames.add(`${image.src}:${numbers[0]}:${numbers[1]}`);
        }
      },
    },
    { get: (target, key) => (key in target ? target[key] : () => {}) },
  );
}
function element(id) {
  if (elements.has(id)) return elements.get(id);
  const context = canvasContext();
  const handlers = new Map();
  const result = {
    id,
    hidden: false,
    textContent: "",
    style: {},
    dataset: {},
    tagName: "DIV",
    focus() {},
    setPointerCapture() {},
    handlers,
    addEventListener(type, handler) {
      handlers.set(type, handler);
    },
    getContext: () => context,
    getBoundingClientRect: () => ({ width: 1280, height: 650 }),
    querySelector: (selector) => element(id + selector),
  };
  elements.set(id, result);
  return result;
}
const html = await readFile(new URL("playground.html", root), "utf8");
const buttons = [...html.matchAll(/<button[^>]*data-gesture="([^"]+)"[^>]*>/g)].map(
  ([tag, name]) => ({
    ...element(name),
    tagName: "BUTTON",
    dataset: Object.fromEntries(
      [...tag.matchAll(/data-(\w+)="([^"]+)"/g)].map(([, key, value]) => [key, value]),
    ),
  }),
);
const facingButtons = ["front", "back"].map((name) => ({
  ...element(name),
  tagName: "BUTTON",
  dataset: { face: name },
}));
const controlButtons = [
  ...html.matchAll(/<button[^>]*data-(?:hold|press|command)="[^"]+"[^>]*>/g),
].map(([tag], index) => ({
  ...element(`control-${index}`),
  tagName: "BUTTON",
  dataset: Object.fromEntries(
    [...tag.matchAll(/data-(\w+)="([^"]+)"/g)].map(([, key, value]) => [key, value]),
  ),
}));
let canvasCount = 0;
globalThis.document = {
  hidden: false,
  createElement: () => element(`offscreen-${canvasCount++}`),
  querySelector: (selector) => element(selector),
  querySelectorAll: (selector) =>
    selector === "[data-gesture]"
      ? buttons
      : selector === "[data-face]"
        ? facingButtons
        : selector === "[data-command]"
          ? controlButtons.filter((button) => button.dataset.command)
          : selector === "[data-hold],[data-press]"
            ? controlButtons.filter((button) => button.dataset.hold || button.dataset.press)
            : [],
  addEventListener: (type, handler) => documentListeners.set(type, handler),
};
globalThis.window = { addEventListener: (type, handler) => listeners.set(type, handler) };
globalThis.matchMedia = () => ({ matches: false });
globalThis.devicePixelRatio = 2;
globalThis.ResizeObserver = class {
  constructor(callback) {
    this.callback = callback;
  }
  observe() {
    this.callback();
  }
};
globalThis.requestAnimationFrame = (callback) => {
  pendingFrame = callback;
  return 1;
};
globalThis.cancelAnimationFrame = () => {
  pendingFrame = null;
};
globalThis.fetch = async (input) => {
  try {
    const response = new Response(await readFile(fileURLToPath(new URL(String(input), root))));
    const blob = await response.blob();
    blob.sourceUrl = String(input);
    return { ok: true, json: () => blob.text().then(JSON.parse), blob: async () => blob };
  } catch {
    return new Response("", { status: 404 });
  }
};
const decodedImages = [];
globalThis.createImageBitmap = async (blob) => {
  const bytes = Buffer.from(await blob.arrayBuffer());
  assert.equal(bytes.subarray(0, 4).toString(), "RIFF");
  assert.equal(bytes.subarray(8, 12).toString(), "WEBP");
  const image = { src: blob.sourceUrl, closed: 0, close() { this.closed++; } };
  decodedImages.push(image);
  return image;
};
function key(type, code, tagName = "CANVAS", shiftKey = false) {
  listeners.get(type)({ code, target: { tagName }, preventDefault() {}, repeat: false, shiftKey });
}
async function advance(frames = 1) {
  for (let index = 0; index < frames; index++) {
    const callback = pendingFrame;
    pendingFrame = null;
    now += 1000 / 60;
    if (callback) callback(now);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

async function advanceUntilImage(pattern, message) {
  // Allow slow CI asset reads/decodes several seconds of real time; simulated
  // frames can advance before decoding completes. Keep missing input bounded.
  const assetDecodeBudgetMs = 5_000;
  const deadline = performance.now() + assetDecodeBudgetMs;
  while (!pattern.test(drawnImage) && performance.now() < deadline) await advance();
  assert.match(drawnImage, pattern, message);
}

await import("../playground.mjs");

test("a front-facing turn follows one source sweep without wrapping across a take seam", async () => {
  const clip = JSON.parse(await readFile(new URL("assets/game/rotation/clip.json", root)));
  const front = clip.frames.filter((frame) => Math.abs(frame.yaw) < 89);
  for (let i = 1; i < front.length; i++) {
    assert.ok(
      Math.abs(front[i].source_frame - front[i - 1].source_frame) <= 1,
      `Turn crossed a discontinuity from source frame ${front[i - 1].source_frame} to ${front[i].source_frame}`,
    );
  }
});

test("page boot, real asset loads, keyboard directions, pause and reset work together", async () => {
  for (let i = 0; i < 200 && !element("#loading").hidden; i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(
    element("#loading").hidden,
    true,
    element("#loading").querySelector("p").textContent,
  );
  await advance(10);
  assert.match(drawnImage, /\/idle\//);
  idleFrames.clear();
  await advance(120);
  assert.ok(
    idleFrames.size >= 46,
    `Expected about 48 distinct idle frames in two seconds, saw ${idleFrames.size}`,
  );
  key("keydown", "ArrowLeft");
  await advance(42);
  assert.match(drawnImage, /\/walk-left\//);
  key("keydown", "KeyA");
  key("keyup", "ArrowLeft");
  await advance(12);
  assert.match(drawnImage, /\/walk-left\//, "A must stay held after releasing its arrow-key alias");
  key("keyup", "KeyA");
  await advance(25);
  assert.match(drawnImage, /\/idle-left\//);
  key("keydown", "KeyF");
  await advance(36);
  assert.match(drawnImage, /\/idle-front\//);
  key("keydown", "KeyB");
  await advanceUntilImage(/\/idle-back\//);
  facingButtons[0].onclick();
  await advanceUntilImage(/\/idle-front\//);
  key("keydown", "ArrowLeft");
  await advance(36);
  assert.match(drawnImage, /\/walk-left\//);
  key("keyup", "ArrowLeft");
  await advance(20);
  key("keydown", "Space", "BUTTON");
  await advance(4);
  assert.match(
    drawnImage,
    /\/idle-left\//,
    "Space should activate focused controls instead of jumping",
  );
  key("keydown", "Space");
  await advance(30);
  assert.match(drawnImage, /\/jump\//);
  element("#pause").onclick();
  assert.equal(pendingFrame, null);
  assert.equal(element("#pause-overlay").hidden, false);
  element("#reset").onclick();
  await advance(16);
  assert.equal(element("#pause-overlay").hidden, true);
  assert.match(drawnImage, /\/idle\//);
  document.hidden = true;
  documentListeners.get("visibilitychange")();
  assert.equal(pendingFrame, null, "Hidden tabs must stop animation scheduling");
  document.hidden = false;
  documentListeners.get("visibilitychange")();
  assert.ok(pendingFrame);
  for (const [code, name] of [
    ["Digit6", "tiptoe"],
    ["Digit7", "pond-hops"],
    ["Digit8", "balance"],
    ["Digit9", "crossed-arms"],
  ]) {
    element("#reset").onclick();
    await advance(10);
    key("keydown", code);
    await advanceUntilImage(new RegExp(`/${name}/`), `${code} must load and play ${name}`);
  }
  assert.equal(
    new Set(buttons.map((button) => button.dataset.code)).size,
    buttons.length,
    "Each emote has a unique single key",
  );
  for (const button of buttons) {
    element("#reset").onclick();
    await advance(10);
    assert.equal(button.disabled, false, `${button.dataset.gesture} must be available`);
    key("keydown", button.dataset.code);
    await advanceUntilImage(
      new RegExp(`/${button.dataset.gesture}/`),
      `${button.dataset.code} must play the corresponding gesture`,
    );
  }
  controlButtons.find((button) => button.dataset.command === "reset").onclick();
  await advance(10);
  const right = controlButtons.find((button) => button.dataset.hold === "right");
  right.handlers.get("keydown")({ code: "Space", preventDefault() {}, repeat: false });
  await advance(60);
  assert.match(
    drawnImage,
    /\/walk-right\//,
    "Focused virtual movement keys support keyboard activation",
  );
  right.handlers.get("keyup")({ code: "Space", preventDefault() {} });
  await advance(30);
  assert.match(drawnImage, /\/idle-right\//);
  const climb = controlButtons.find((button) => button.dataset.hold === "climb");
  const inputs = [];
  const update = World.prototype.update;
  World.prototype.update = function (dt, input) {
    inputs.push(input);
    return update.call(this, dt, input);
  };
  try {
    climb.handlers.get("keydown")({ code: "Enter", preventDefault() {}, repeat: false });
    await advance(5);
    climb.handlers.get("keyup")({ code: "Enter", preventDefault() {} });
    assert.ok(
      inputs.some((input) => input.climbPressed),
      "Virtual W must issue the same grab/climb request as physical W",
    );
  } finally {
    World.prototype.update = update;
  }
  controlButtons.find((button) => button.dataset.command === "pause").onclick();
  assert.equal(element("#pause-overlay").hidden, false);
  element("#resume").onclick();
});

masterTest(
  "source-motion tricks preserve the recorded trajectory without extra controller travel",
  async () => {
    for (const name of ["punch-jump", "dramatic-faint", "zero-gravity"]) {
      const clip = JSON.parse(await readFile(new URL(`assets/game/${name}/clip.json`, root)));
      const atlas = JSON.parse(
        await readFile(new URL(`assets/production/sprites/${clip.source}/atlas.json`, root)),
      );
      const scale = 384 / atlas.standing_height_source_px;
      const origins = clip.frames.map((frame) => {
        const rect = atlas.frames[frame.source_index].source_rect;
        return { x: rect.x + frame.anchor.x / scale, y: rect.y + frame.anchor.y / scale };
      });
      for (const origin of origins) {
        assert.ok(
          Math.abs(origin.x - origins[0].x) < 1e-8,
          `${name}: horizontal source motion was recentered`,
        );
        assert.ok(
          Math.abs(origin.y - origins[0].y) < 1e-8,
          `${name}: vertical source motion was canceled`,
        );
      }
      assert.equal(clip.fps, 24);
      assert.ok(clip.finish_before_next);
      const world = new World();
      world.clips[name] = { ...clip, frames: clip.frames.length };
      world.gestureDurations[name] = clip.frames.length / clip.fps;
      world.update(1 / 60, { gesture: name });
      for (let frame = 0; frame < clip.frames.length * 3; frame++) {
        world.update(1 / 60);
        assert.equal(world.player.x, 260, `${name}: controller added horizontal travel`);
        assert.equal(world.player.y, 620, `${name}: controller added a second jump`);
      }
    }
  },
);

test("jump, hang, mantle and climb recovery all face toward the approached ledge", async () => {
  const manifest = JSON.parse(await readFile(new URL("assets/game/manifest.json", root)));
  const world = new World();
  Object.assign(world, { clips: manifest.clips, angles: manifest.angles });
  for (const facing of [-1, 1]) {
    for (const name of ["jump", "hang", "climb", "climb-rest"]) {
      for (let index = 0; index < manifest.angles[name].length; index++) {
        assert.ok(
          world.poseYaw(name, facing, index) * facing > 0,
          `${name}/${index} must face ${facing === 1 ? "right" : "left"}`,
        );
      }
    }
  }
  const hang = JSON.parse(await readFile(new URL("assets/game/hang/clip.json", root)));
  const climb = JSON.parse(await readFile(new URL("assets/game/climb/clip.json", root)));
  assert.equal(hang.frames[0].source_clip, "15-climb-right");
  assert.equal(hang.frames[0].source_frame, climb.frames[0].source_frame);
  assert.deepEqual(hang.frames[0].anchor, climb.frames[0].anchor);
});

test("the tether shares the tracked connector with both images throughout mirrored pose blends", () => {
  const scale = HEIGHT / 384;
  for (const mirrored of [false, true]) {
    const outgoing = { x: 320, y: 440, mirrored: !mirrored, frame: { socket: { x: 24, y: -315 } } };
    const incoming = { x: 320, y: 440, mirrored, frame: { socket: { x: -18, y: -275 } } };
    for (const blend of [0, 0.2, 0.5, 0.8, 1]) {
      const display = blendAtSocket(incoming, outgoing, blend, scale);
      for (const pose of [display.incoming, display.outgoing].filter(Boolean)) {
        const socket = socketPosition(pose, scale);
        assert.ok(Math.hypot(socket.x - display.endpoint.x, socket.y - display.endpoint.y) < 1e-8);
      }
    }
  }
});

test("climb completion and the outgoing blend preserve the exact world position of sprite pixels", async () => {
  const manifest = JSON.parse(await readFile(new URL("assets/game/manifest.json", root)));
  const climb = JSON.parse(await readFile(new URL("assets/game/climb/clip.json", root)));
  const rest = JSON.parse(await readFile(new URL("assets/game/climb-rest/clip.json", root)));
  const lastFrame = climb.frames.at(-1);
  const restFrame = rest.frames[0];
  assert.equal(
    lastFrame.source_frame,
    restFrame.source_frame,
    "Completion must retain the actual last image",
  );
  for (const facing of [-1, 1]) {
    const player = {
      x: 690 - facing * 24,
      y: 460 + HEIGHT,
      facing,
      ledge: { edge: 690, platform: { top: 460 } },
      mode: "climb",
    };
    const outgoing = positionPose({ clip: climb, frame: lastFrame }, player);
    Object.assign(player, {
      x: 690 + facing * manifest.climb_exit.x * HEIGHT,
      y: 460 + manifest.climb_exit.y * HEIGHT,
      ledge: null,
      mode: "ground",
    });
    const incoming = positionPose({ clip: rest, frame: restFrame }, player);
    for (const axis of ["x", "y"]) {
      const sign = axis === "x" ? facing : 1;
      const before = outgoing[axis] - (sign * lastFrame.anchor[axis] * HEIGHT) / 384;
      const after = incoming[axis] - (sign * restFrame.anchor[axis] * HEIGHT) / 384;
      assert.ok(
        Math.abs(before - after) < 0.00001,
        `${axis} position must survive re-registration`,
      );
    }
    const transition = { pose: outgoing, playerX: player.x, playerY: player.y };
    assert.equal(transitionPose(transition, player).x, outgoing.x);
    player.x += 2;
    assert.equal(transitionPose(transition, player).x, outgoing.x + 2);
  }
});

test("camera-facing stances never mirror when the last walking direction was left", async () => {
  for (const name of ["idle-front", "idle-back"]) {
    const clip = JSON.parse(await readFile(new URL(`assets/game/${name}/clip.json`, root)));
    assert.equal(
      positionPose({ clip }, { x: 1, y: 2, facing: -1, hasMoved: true }).mirrored,
      false,
    );
  }
});

test("the front-facing rotation endpoint and its resting image need no redundant blend", async () => {
  const rotation = JSON.parse(await readFile(new URL("assets/game/rotation/clip.json", root)));
  const front = JSON.parse(await readFile(new URL("assets/game/idle-front/clip.json", root)));
  const player = { x: 260, y: 620, facing: 1 };
  const outgoing = positionPose(
    { clip: rotation, frame: rotation.frames.find((frame) => frame.yaw === 0) },
    player,
  );
  const incoming = positionPose({ clip: front, frame: front.frames[0] }, player);
  assert.equal(samePoseImage(outgoing, incoming), true);
  assert.equal(samePoseImage(outgoing, { ...incoming, mirrored: true }), false);
  assert.equal(samePoseImage(outgoing, { ...incoming, x: 262 }), false);
  assert.equal(
    samePoseImage(outgoing, { ...incoming, frame: { ...incoming.frame, source_frame: 209 } }),
    false,
  );
});

test("every landing frame removes the source video descent and keeps the soles at ground level", async () => {
  const land = JSON.parse(await readFile(new URL("assets/game/land/clip.json", root)));
  const rest = JSON.parse(await readFile(new URL("assets/game/land-rest/clip.json", root)));
  assert.equal(land.frames.length / land.fps, 0.25);
  assert.ok(land.frames[0].source_seconds >= 4.125, "Pointed-toe airborne frames must be excluded");
  for (const frame of land.frames) {
    const soleOffset = frame.h - frame.anchor.y;
    assert.ok(
      soleOffset >= 0 && soleOffset < 2,
      `Landing frame has ${soleOffset}px of baked vertical translation`,
    );
  }
  assert.deepEqual(land.frames.at(-1).anchor, rest.frames[0].anchor);
  assert.equal(land.frames.at(-1).source_frame, rest.frames[0].source_frame);
});

masterTest(
  "balance and crossed arms keep planted soles while pond hops retain their airborne rise",
  async () => {
    for (const name of ["balance", "crossed-arms"]) {
      const clip = JSON.parse(await readFile(new URL(`assets/game/${name}/clip.json`, root)));
      for (const frame of clip.frames) {
        const soleOffset = frame.h - frame.anchor.y;
        assert.ok(
          soleOffset >= 0 && soleOffset < 2,
          `${name}/${frame.source_index} must stay planted`,
        );
      }
    }
    const hops = JSON.parse(await readFile(new URL("assets/game/pond-hops/clip.json", root)));
    const atlas = JSON.parse(
      await readFile(new URL("assets/production/sprites/17-pond-hops/atlas.json", root)),
    );
    const scale = hops.standing_height / atlas.standing_height_source_px;
    for (const frame of hops.frames) {
      const source = atlas.frames[frame.source_index];
      assert.ok(
        Math.abs(source.source_rect.y + frame.anchor.y / scale - atlas.neutral_anchor.y) < 1e-6,
      );
    }
    assert.ok(
      Math.max(...hops.frames.map((frame) => frame.anchor.y - frame.h)) > 20,
      "Hop apex must not be flattened to the floor",
    );
  },
);

test("the spare arm uses the clean removal and reverses the same frames for reassembly", async () => {
  const clip = JSON.parse(await readFile(new URL("assets/game/arm-inspection/clip.json", root)));
  const indices = clip.frames.map((frame) => frame.source_index);
  assert.deepEqual(indices, [
    ...Array.from({ length: 61 }, (_, i) => i),
    ...new Array(12).fill(60),
    ...Array.from({ length: 60 }, (_, i) => 59 - i),
  ]);
  assert.equal(clip.frames[0].source_frame, clip.frames.at(-1).source_frame);
  for (let i = 1; i < indices.length; i++) assert.ok(Math.abs(indices[i] - indices[i - 1]) <= 1);
  assert.ok(clip.finish_before_next);
});

test("the retired moonwalk has no gameplay shortcut or manifest entry", async () => {
  const manifest = JSON.parse(await readFile(new URL("assets/game/manifest.json", root)));
  assert.equal(manifest.clips.moonwalk, undefined);
  assert.equal(
    buttons.some((button) => button.dataset.gesture === "moonwalk"),
    false,
  );
});

test("workshop keeps pages for bfcache and closes them on permanent departure", async () => {
  listeners.get("pagehide")({ persisted: true });
  assert.ok(decodedImages.some((image) => image.closed === 0));
  listeners.get("pagehide")({ persisted: false });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(decodedImages.every((image) => image.closed === 1));
  assert.equal(pendingFrame, null);
});
