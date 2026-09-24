/** Autonomy timing, readiness and cancellation regressions (PRD §13.3, C-SITE-03). */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Autonomy } from "../autonomy.mjs";
import { FLOOR, World } from "../world.mjs";

const manifest = JSON.parse(readFileSync(new URL("../assets/game/manifest.json", import.meta.url)));
function setup(initialSeed = 71027) {
  // Deterministic generator state, advanced on every draw.
  let seed = initialSeed;
  const world = new World();
  Object.assign(world, {
    clips: manifest.clips,
    angles: manifest.angles,
    rotationAngles: manifest.rotation_angles,
    walkTransitions: manifest.walk_transitions,
    walkStarts: manifest.walk_starts,
    platforms: [],
    bounds: { left: 75, right: 650 },
  });
  for (const [name, clip] of Object.entries(manifest.clips))
    world.gestureDurations[name] = clip.frames / clip.fps;
  const director = new Autonomy({
    random: () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    },
  });
  const advance = (seconds, input = null) => {
    for (let i = 0; i < Math.round(seconds * 120); i++) {
      const auto = director.update(1 / 120, world, world.bounds, !!input);
      world.update(1 / 120, input ?? auto);
    }
  };
  return { world, director, advance };
}

test("autonomy keeps choosing varied moments, walks and pauses without leaving the visible bounds", () => {
  const { world, director } = setup();
  const gestures = new Set();
  let walking = 0;
  let holding = 0;
  for (let tick = 0; tick < 120 * 300; tick++) {
    world.update(1 / 120, director.update(1 / 120, world, world.bounds));
    if (world.player.gesture) gestures.add(world.player.gesture);
    walking += world.player.animation.startsWith("walk");
    holding += world.player.gestureStage === "hold";
    assert.ok(world.player.x >= 75 && world.player.x <= 650);
    assert.ok(Number.isFinite(world.player.x) && Number.isFinite(world.player.y));
  }
  assert.ok(gestures.size >= 8, `Expected a varied performance, saw ${[...gestures]}`);
  assert.ok(walking > 1000);
  assert.ok(holding > 100);
});

test("manual movement holds its stance for five seconds, then idles visibly before returning control", () => {
  const { world, director, advance } = setup();
  advance(4);
  director.interact();
  advance(1, { axis: 1 });
  assert.equal(director.mode, "manual");
  advance(4.5);
  assert.equal(director.mode, "manual");
  assert.equal(world.player.animation, "idle-right");
  const x = world.player.x;
  advance(1.5);
  assert.equal(director.mode, "manual");
  assert.equal(world.player.animation, "idle");
  assert.equal(world.player.x, x);
  advance(3.5);
  assert.equal(director.mode, "auto");
});

test("holding a movement key prevents automatic takeover for any length of time", () => {
  const { director, advance } = setup();
  advance(40, { axis: -1 });
  assert.equal(director.mode, "manual");
  assert.equal(director.quiet, 0);
});

test("a manual held pose recovers and shows a full idle pause before autonomy resumes", () => {
  const { world, director, advance } = setup();
  director.interact();
  advance(1 / 120, { gesture: "criss-cross" });
  advance(6);
  assert.equal(director.mode, "manual");
  assert.equal(world.player.gesture, "criss-cross");
  let idleStarted = null;
  for (let i = 0; i < 120 * 20 && director.mode === "manual"; i++) {
    advance(1 / 120);
    if (world.player.animation === "idle" && idleStarted === null) idleStarted = world.time;
  }
  assert.equal(director.mode, "auto");
  assert.ok(idleStarted !== null);
  assert.ok(
    world.time - idleStarted >= 3.5,
    "Standing recovery must not consume the visible idle interval",
  );
});

test("an automatic gesture awaiting its image cannot start after a manual takeover", () => {
  const { world, director, advance } = setup();
  let ready = false;
  director.ensureDeliveryReady = () => ready;
  director.task = { kind: "moment", name: "wave", sent: false, seen: false, elapsedSeconds: 0, hold: 3 };
  advance(1);
  assert.equal(world.player.gesture, null);
  director.interact();
  ready = true;
  advance(1, { axis: -1 });
  assert.equal(world.player.gesture, null);
  assert.equal(director.mode, "manual");
});

test("an abandoned ledge grab climbs to safety before the idle handoff", () => {
  const { world, director, advance } = setup();
  const platform = { id: "ledge", x: 250, width: 200, top: 500, solid: false };
  world.platforms = [platform];
  Object.assign(world.player, {
    mode: "hang",
    animation: "hang",
    x: 226,
    y: 636,
    ledge: { edge: 250, platform },
  });
  director.interact();
  advance(4);
  assert.equal(world.player.mode, "hang");
  advance(2);
  assert.equal(world.player.mode, "climb");
  advance(15);
  assert.equal(director.mode, "auto");
});

test("automatic climbing leaves room for the robot above the selected letter", () => {
  const { world, director } = setup();
  world.bounds.top = 530;
  world.platforms = [
    { id: "too-high", x: 200, width: 100, top: 490 },
    { id: "visible", x: 200, width: 100, top: 550 },
  ];
  director.random = () => 0;
  director.choose(world, world.bounds);
  assert.equal(director.task.platform.id, "visible");
});

test("an oversized automatic trick is rejected before loading its image page", () => {
  const { world, director, advance } = setup();
  let imageRequests = 0;
  director.fits = () => false;
  director.ensureDeliveryReady = () => {
    imageRequests++;
    return true;
  };
  director.task = { kind: "moment", name: "cartwheel", sent: false, elapsedSeconds: 0, hold: 3 };
  advance(1 / 120);
  assert.equal(imageRequests, 0);
  assert.equal(world.player.gesture, null);
  assert.equal(director.task.kind, "rest");
});

test("poster letters can be jumped through from below and landed on, while custom edges remain bounded", () => {
  const { world } = setup();
  world.platforms = [{ id: "letter", x: 200, width: 200, top: 540, solid: false }];
  world.player.x = 175;
  for (let i = 0; i < 120; i++) world.update(1 / 120, { axis: 1 });
  assert.ok(world.player.x > 221, "Typography must not become an invisible floor-to-ceiling wall");
  world.update(1 / 120, { jumpPressed: true });
  for (let i = 0; i < 240; i++) world.update(1 / 120);
  assert.equal(world.player.y, 540);
  assert.equal(world.player.support.id, "letter");
  world.reset();
  world.bounds = { left: -100, right: 500 };
  world.platforms = [];
  for (let i = 0; i < 1200; i++) world.update(1 / 120, { axis: -1 });
  assert.equal(world.player.x, -100);
  assert.equal(world.player.y, FLOOR);
});

test("first arrival plays idle for five seconds unless manual input takes over", () => {
  const { world, director, advance } = setup();
  advance(4.9);
  assert.equal(world.player.animation, "idle");
  assert.equal(world.player.x, 260);
  director.interact();
  advance(0.5, { axis: 1 });
  assert.equal(director.mode, "manual");
  assert.ok(world.player.x > 260);
});
