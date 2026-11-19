import assert from "node:assert/strict";
import test from "node:test";
import { recordDragSample, throwVelocity } from "../drag/throw.mjs";
import { FLOOR, HEIGHT, World } from "../world.mjs";
import { stepWorld as step } from "./helpers/step-world.mjs";

function thrownWorld() {
  const world = new World();
  world.platforms = [];
  world.bounds = { left: 100, right: 500, top: FLOOR - 400 };
  world.clips["pickup-fall"] = { frames: 1, fps: 24 };
  world.clips["hero-land"] = { frames: 48, fps: 24, finish_before_next: true };
  world.gestureDurations["hero-land"] = 2;
  Object.assign(world.player, { x: 300, y: FLOOR - 200 });
  return world;
}

function samples(...points) {
  const recorded = [];
  for (const [timeMs, x, y] of points) recordDragSample(recorded, { timeMs, x, y });
  return recorded;
}

const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} is not ${expected}`);

test("C-SITE-07 a release keeps 35% of the held robot's velocity over the last 100 ms of movement", () => {
  // The first sample is off the line of the others: counting it would change the answer.
  const moving = samples([880, 500, 500], [900, 100, 300], [950, 120, 290], [1000, 140, 280]);
  assert.equal(moving.length, 3, "movement more than 100 ms before the latest is forgotten");
  const velocity = throwVelocity(moving, 1004);
  near(velocity.x, 140);
  near(velocity.y, -70);
  assert.equal(samples([900, 0, 0], [1000, 40, 0]).length, 2, "movement exactly 100 ms old still counts");
});

test("C-SITE-07 a release that is not a moving pointer is a plain drop", () => {
  const moving = () => samples([980, 100, 300], [1000, 140, 280]);
  assert.ok(throwVelocity(moving(), 1060), "60 ms after the last movement is still a moving pointer");
  assert.equal(throwVelocity(moving(), 1061), null, "after 60 ms the pointer had stopped");
  assert.equal(throwVelocity(moving(), undefined), null, "keyboard, cancel and blur carry no time");
  assert.equal(throwVelocity(samples([1000, 140, 280]), 1004), null, "one position has no direction");
  assert.equal(throwVelocity(samples([1000, 0, 0], [1000, 50, 0]), 1000), null, "no time passed");
});

test("C-SITE-07 the held robot must be moving at 150 world pixels per second", () => {
  near(throwVelocity(samples([900, 0, 0], [1000, 15, 0]), 1000).x, 52.5);
  assert.equal(throwVelocity(samples([900, 0, 0], [1000, 14.9, 0]), 1000), null);
});

test("C-SITE-07 a hard flick keeps its direction at 420 world pixels per second", () => {
  const velocity = throwVelocity(samples([950, 0, 0], [1000, 300, -400]), 1000);
  near(Math.hypot(velocity.x, velocity.y), 420);
  near(velocity.x / velocity.y, -0.75);
  const atLimit = throwVelocity(samples([900, 0, 0], [1000, 120, 0]), 1000);
  near(atLimit.x, 420);
});

test("C-SITE-07 a released robot keeps its motion, ignores steering and stops at the edge without rebounding", () => {
  const world = thrownWorld();
  world.releaseFromPickup({ x: 400, y: -100 });
  assert.equal(world.player.animation, "pickup-fall");
  step(world, 0.2, { axis: -1 });
  assert.equal(world.player.vx, 400, "steering does not change the motion");
  assert.ok(world.player.x > 370);
  const speeds = new Set();
  step(world, 0.4, {}, (player) => {
    speeds.add(player.vx);
    assert.ok(player.x <= 500);
  });
  assert.deepEqual([...speeds], [400, 0], "the edge stops him; he falls straight from there");
});

test("C-SITE-07 a released robot lands planted where it comes down", () => {
  const world = thrownWorld();
  world.releaseFromPickup({ x: -150, y: -200 });
  step(world, 2);
  const player = world.player;
  assert.ok(player.x < 300 && player.x > 100);
  assert.equal(player.mode, "ground");
  assert.equal(player.y, FLOOR);
  assert.equal(player.vx, 0);
  assert.equal(player.thrown, false);
  assert.equal(player.gesture, "hero-land");
});

test("C-SITE-07 a release without velocity still drops straight down", () => {
  const world = thrownWorld();
  world.releaseFromPickup();
  assert.deepEqual([world.player.vx, world.player.vy, world.player.thrown], [0, 30, false]);
  step(world, 0.2, { axis: 1 });
  assert.equal(world.player.vx, 0);
});

for (const [face, from, velocity] of [["left", 300, 400], ["right", 600, -400]]) {
  test(`C-SITE-07 a thrown robot stops at the ${face} side of a solid block without rebounding`, () => {
    const world = thrownWorld();
    world.bounds = { left: 100, right: 800, top: FLOOR - 400 };
    const block = { x: 420, width: 60, top: FLOOR - 300, solid: true };
    world.platforms = [block];
    world.player.x = from;
    world.releaseFromPickup({ x: velocity, y: -100 });
    const speeds = new Set();
    const reached = [];
    step(world, 2, {}, (player) => {
      speeds.add(player.vx);
      reached.push(player.x);
    });
    assert.deepEqual([...speeds], [velocity, 0]);
    const stop = velocity > 0 ? Math.max(...reached) : Math.min(...reached);
    const side = velocity > 0 ? block.x : block.x + block.width;
    assert.ok(Math.abs(stop - side) < 40 && (stop - side) * velocity < 0, `stopped at ${stop}`);
    assert.equal(world.player.x, stop, "he falls straight down from where he stopped");
    assert.equal(world.player.gesture, "hero-land");
  });
}

test("C-SITE-07 catching a ledge ends the throw, so a later drop from it is steered", () => {
  const world = thrownWorld();
  world.releaseFromPickup({ x: 200, y: -200 });
  world.grab({ edge: 300, platform: { x: 300, width: 100, top: FLOOR - HEIGHT - 60 }, direction: 1 });
  assert.equal(world.player.thrown, false);
  world.release();
  step(world, 0.1, { axis: 1 });
  assert.ok(world.player.vx > 0);
});
