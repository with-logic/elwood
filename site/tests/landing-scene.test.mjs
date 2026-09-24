/** Landing lifecycle and animation behavior (PRD §13; initial handoff C-SITE-02). */
import { resolveObjectURL } from "node:buffer";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { LandingScene } from "../landing-scene.mjs";
import { socketPosition } from "../sprite-pose.mjs";

const root = new URL("../", import.meta.url);
const requests = [];
let now = 0;
let serial = 0;
let reduced = false;
const frames = new Map();
function canvas() {
  const context = new Proxy(
    {
      measureText: () => ({ width: 210, actualBoundingBoxAscent: 210 }),
      getTransform: () => ({ e: 0, f: 0 }),
      drawImage(_image, ...coordinates) {
        assert.ok(!_image.closed, "A rendered sprite must still be owned");
        assert.ok(coordinates.every(Number.isFinite), "Drawing coordinates must stay finite");
      },
    },
    { get: (target, key) => (key in target ? target[key] : () => {}) },
  );
  return { width: 1200, height: 800, getContext: () => context };
}
globalThis.document = { createElement: canvas };
globalThis.matchMedia = () => ({ matches: reduced });
globalThis.devicePixelRatio = 2;
globalThis.requestAnimationFrame = (callback) => {
  const id = ++serial;
  frames.set(id, callback);
  return id;
};
globalThis.cancelAnimationFrame = (id) => frames.delete(id);
globalThis.fetch = async (input) => {
  requests.push(String(input));
  try {
    return new Response(await readFile(fileURLToPath(new URL(String(input), root))), {
      status: 200,
    });
  } catch {
    return new Response("", { status: 404 });
  }
};
globalThis.Image = class {
  closed = 0;
  close() {
    this.closed++;
  }
  async decode() {
    const bytes = Buffer.from(await resolveObjectURL(this.src).arrayBuffer());
    assert.equal(bytes.subarray(0, 4).toString(), "RIFF");
    assert.equal(bytes.subarray(8, 12).toString(), "WEBP");
  }
};
const errors = [];
const scene = new LandingScene(canvas(), { onError: (error) => errors.push(error.message) });
scene.configure({
  width: 1200,
  height: 800,
  scale: 1.5,
  floorY: 640,
  robotX: 600,
  terminal: { x: 600, y: 170 },
  platforms: [],
});
async function advance(seconds) {
  for (let tick = 0; tick < seconds * 60; tick++) {
    now += 1000 / 60;
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(now);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

test("landing starts with complete retained idle and never fetches videos", async () => {
  await scene.boot();
  assert.equal(scene.ready, true);
  for (const [index] of scene.bank.clips.get("idle").frames.entries())
    assert.ok(scene.bank.frame("idle", index));
  assert.deepEqual([...scene.bank.clips.keys()], ["idle"]);
  assert.ok(requests.every((url) => !url.endsWith(".mp4")));
  assert.deepEqual(errors, []);
});

test("the actual scene gives manual movement priority and idles before resuming autonomy", async () => {
  scene.interact();
  scene.axis = 1;
  await advance(1.2);
  assert.equal(scene.director.mode, "manual");
  assert.equal(scene.world.player.animation, "walk-right");
  scene.clearInput();
  await advance(6);
  assert.equal(scene.world.player.animation, "idle");
  assert.equal(scene.director.mode, "manual");
  const x = scene.world.player.x;
  await advance(1.5);
  assert.equal(scene.world.player.x, x);
  await advance(2.5);
  assert.equal(scene.director.mode, "auto");
  assert.deepEqual(errors, []);
});

test("a gesture load completing after movement cannot steal manual control", async () => {
  const request = scene.request({ gesture: "wave" });
  scene.interact();
  scene.axis = -1;
  await request;
  assert.equal(scene.pressed.gesture, undefined);
  await advance(0.8);
  assert.notEqual(scene.world.player.gesture, "wave");
  scene.clearInput();
});

test("hidden, offscreen and help pauses stop scheduling without overriding one another", async () => {
  scene.pause("hidden", true);
  scene.pause("help", true);
  assert.equal(frames.size, 0);
  const clock = scene.world.time;
  await advance(1);
  assert.equal(scene.world.time, clock);
  scene.pause("hidden", false);
  assert.equal(frames.size, 0);
  scene.pause("help", false);
  assert.equal(frames.size, 1);
  scene.pause("offscreen", true);
  assert.equal(frames.size, 0);
  scene.pause("offscreen", false);
  assert.equal(frames.size, 1);
});

test("decoded image memory stays bounded while different moments are prepared", async () => {
  scene.pause("test", true);
  for (const name of ["thinking", "shrug", "balance", "criss-cross", "zero-gravity", "bow"]) {
    await scene.bank.prepare(name);
    assert.ok(scene.bank.pages.size <= 4);
  }
  assert.ok(requests.every((url) => !url.endsWith(".mp4")));
});

test("automatic tricks must fit their full recorded silhouette and travel inside the poster", async () => {
  scene.configure(
    {
      ...scene.config,
      width: 1200,
      height: 800,
      scale: 1.5,
      floorY: 640,
      robotX: 600,
      platforms: [],
    },
    true,
  );
  await scene.bank.load("punch-jump");
  await scene.bank.load("cartwheel");
  assert.equal(scene.performanceFits("punch-jump"), true);
  scene.world.player.y = 300;
  assert.equal(
    scene.performanceFits("punch-jump"),
    false,
    "An airborne punch must not leave the top of the poster",
  );
  scene.world.player.y = 620;
  scene.world.player.x = scene.world.bounds.right;
  assert.equal(
    scene.performanceFits("cartwheel"),
    false,
    "Recorded travel and outstretched limbs need room together",
  );
});

test("reduced motion has a still first paint and starts only after explicit interaction", async () => {
  reduced = true;
  const quiet = new LandingScene(canvas());
  await quiet.boot();
  assert.equal(quiet.raf, 0);
  assert.ok(quiet.lastPose);
  quiet.interact();
  assert.ok(quiet.raf);
  quiet.pause("test", true);
});

test("ground marks stay at their original coordinates when Elwood walks away", () => {
  scene.configure({ ...scene.config, platforms: [] }, true);
  const marks = structuredClone(scene.groundMarks);
  assert.ok(marks?.length > 0);
  scene.interact();
  scene.axis = 1;
  for (let i = 0; i < 120; i++) scene.step(1 / 120);
  assert.deepEqual(scene.groundMarks, marks);
  scene.clearInput();
});

test("pickup suspends physics, follows the pointer, and release falls to a planted landing", async () => {
  scene.configure({ ...scene.config, platforms: [] }, true);
  scene.clearInput();
  assert.equal(scene.beginDrag({ x: 400, y: 540 }), true);
  scene.moveDrag({ x: 500, y: 330 });
  for (let i = 0; i < 120; i++) scene.step(1 / 120);
  assert.equal(scene.dragging, true);
  assert.equal(scene.world.player.mode, "drag");
  const y = scene.world.player.y;
  assert.ok(y < 620);
  scene.endDrag();
  assert.equal(scene.dragging, false);
  assert.equal(scene.world.player.mode, "air");
  for (let i = 0; i < 360; i++) scene.step(1 / 120);
  assert.equal(scene.world.player.mode, "ground");
  assert.equal(scene.world.player.y, 620);
  assert.equal(scene.world.player.vx, 0);
  assert.deepEqual(
    scene.groundMarks,
    [{ x: scene.config.robotX / scene.config.scale, y: 620 }],
    "The poster keeps its one ground mark centre screen, not under the landing",
  );
});

test("the wide poster headline is a solid ledge he stands on, falls off, and climbs back onto", async () => {
  const heading = { id: "heading", x: 250, width: 300, top: 620 - 160, solid: true };
  scene.configure({ ...scene.config, platforms: [heading] }, true);
  const p = scene.world.player;
  const stepUntil = async (seconds, done) => {
    for (let i = 0; i < seconds * 120 && !done(); i++) {
      scene.step(1 / 120);
      if (i % 6 === 5) await new Promise((resolve) => setTimeout(resolve, 1));
    }
  };
  assert.equal(p.y, heading.top, "He spawns on top of the headline");
  assert.equal(p.support, heading);
  assert.deepEqual(
    scene.groundMarks,
    [{ x: 400, y: heading.top }],
    "The ground mark sits on the headline, centre screen",
  );
  scene.axis = -1;
  scene.interact();
  await stepUntil(8, () => p.mode === "ground" && p.support !== heading && p.landing === 0);
  assert.equal(p.y, 620, "Walking off the side drops him to the baseline");
  assert.equal(p.support, null);
  scene.axis = 1;
  await stepUntil(6, () => p.vx === 0 && p.x > 225);
  assert.ok(
    p.x < heading.x && p.x > heading.x - 40,
    `The block is solid: he stops at its side (x=${p.x.toFixed(1)})`,
  );
  scene.climbHeld = true;
  scene.pressed = { jumpPressed: true };
  await stepUntil(3, () => p.mode === "hang");
  assert.equal(p.mode, "hang", "A jump at the edge catches the headline ledge");
  scene.pressed = { climbPressed: true };
  await stepUntil(8, () => p.mode === "ground");
  assert.equal(p.support, heading, "He climbs back onto the headline");
  scene.axis = 0;
  scene.clearInput();
  // Dropped inside the block's footprint (a pickup released in front of the
  // lettering), he is pushed out beside it instead of being trapped in front.
  Object.assign(p, { x: heading.x + 40, y: 600, mode: "air", vy: 0, support: null });
  await stepUntil(3, () => p.mode === "ground");
  assert.ok(
    p.x <= heading.x - 20,
    `He lands beside the lettering, not in front of it (x=${p.x.toFixed(1)})`,
  );
  Object.assign(p, {
    x: heading.x + heading.width - 30,
    y: 600,
    mode: "air",
    vy: 0,
    support: null,
  });
  await stepUntil(3, () => p.mode === "ground");
  assert.ok(
    p.x >= heading.x + heading.width + 20,
    "Nearer the right side, he is pushed out to the right",
  );
});

test("dedicated pickup stays above the floor and release preserves the connector position", async () => {
  scene.configure({ ...scene.config, platforms: [] }, true);
  await scene.bank.prepare("pickup-wriggle");
  await scene.bank.prepare("pickup-fall");
  scene.beginDrag({ x: 400, y: 500 });
  scene.moveDrag({ x: 400, y: 1000 });
  let pose = scene.pose();
  assert.ok(
    pose.y + ((pose.frame.h - pose.frame.anchor.y) * 136) / 384 <= 620,
    "Suspended toes must not pass through the floor",
  );
  scene.moveDrag({ x: 400, y: 300 });
  pose = scene.pose();
  const before = socketPosition(pose, 136 / 384);
  scene.endDrag();
  const after = socketPosition(scene.pose(), 136 / 384);
  assert.ok(
    Math.hypot(after.x - before.x, after.y - before.y) < 1e-6,
    "Release must not shift the tether plug before gravity acts",
  );
});

test("the fallback hands off once, only after decoded artwork and its tether are painted", async () => {
  let releasePage;
  let requestedPage;
  const waiting = new Promise((resolve) => {
    requestedPage = resolve;
  });
  const page = new Promise((resolve) => {
    releasePage = resolve;
  });
  const decode = Image.prototype.decode;
  Image.prototype.decode = async function () {
    requestedPage();
    await page;
    return decode.call(this);
  };
  let paints = 0;
  const loading = new LandingScene(canvas(), {
    onPaint() {
      paints++;
    },
  });
  try {
    const boot = loading.boot();
    await waiting;
    assert.equal(paints, 0, "A pending sprite page must leave the HTML fallback visible");
    releasePage();
    await boot;
    assert.equal(paints, 1);
    assert.ok(loading.tether.points);
    assert.ok(loading.lastPose);
    loading.paint(0);
    assert.equal(paints, 1, "The handoff happens only once");
  } finally {
    Image.prototype.decode = decode;
    loading.pause("test", true);
  }
});

test("an unavailable initial pose or failed sprite request keeps the fallback", async () => {
  let paints = 0;
  const failures = [];
  const loading = new LandingScene(canvas(), {
    onPaint() {
      paints++;
    },
    onError(error) {
      failures.push(error.message);
    },
  });
  loading.bank.prepareAnimation = async () => {
    throw new Error("offline");
  };
  await loading.boot();
  assert.deepEqual(failures, ["offline"]);
  assert.equal(paints, 0);
  loading.ready = true;
  loading.pose = () => null;
  loading.paint(0);
  assert.equal(paints, 0, "Ready state alone is not a successful canvas paint");
});

test("scene poses survive eviction, release after blends, and close on teardown", async (t) => {
  const owned = new LandingScene(canvas());
  t.after(() => owned.dispose());
  owned.reduced = false;
  await owned.boot();
  await owned.bank.prepare("wave");
  owned.world.player.animation = "wave";
  const outgoing = owned.pose().page;
  await owned.bank.prepare("bow");
  owned.world.player.animation = "bow";
  const incoming = owned.pose().page;
  assert.equal(owned.transition.pose.page, outgoing);
  for (const name of ["idle-left", "walk-right", "walk-left", "jump", "land"])
    await owned.bank.prepare(name);
  assert.equal(outgoing.closed, 0);
  assert.equal(incoming.closed, 0);
  owned.world.time += 1;
  owned.paint(0);
  assert.equal(outgoing.closed, 1, "An expired outgoing blend releases its evicted page");
  assert.equal(incoming.closed, 0);
  owned.dispose();
  owned.dispose();
  assert.equal(incoming.closed, 1);
  assert.equal(owned.lastPose, null);
  assert.equal(owned.transition, null);
  assert.equal(owned.raf, 0);
  assert.equal(owned.ready, false);
  const requestCount = requests.length;
  await owned.boot();
  assert.equal(requests.length, requestCount, "A disposed scene cannot restart loading");
});
