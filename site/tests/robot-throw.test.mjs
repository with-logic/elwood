import assert from "node:assert/strict";
import test from "node:test";
import { MAX_THROW_SPEED, THROW_SHARE, recordDragSample, throwVelocity } from "../drag/throw.mjs";
import { FLOOR, World } from "../world.mjs";

const step = (world, seconds, input = {}, each = () => {}) => {
  for (let index = 0; index < Math.round(seconds * 120); index++) {
    world.update(1 / 120, input);
    each(world.player);
  }
};

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
  for (const [time, x, y] of points) recordDragSample(recorded, time, x, y);
  return recorded;
}

const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} is not ${expected}`);

test("C-SITE-07 a release keeps a share of the last tenth of a second of pointer movement", () => {
  const moving = samples([0, 0, 0], [900, 100, 300], [950, 120, 290], [1000, 140, 280]);
  assert.equal(moving.length, 3, "movement older than the window is forgotten");
  const velocity = throwVelocity(moving, 1004);
  near(velocity.x, 400 * THROW_SHARE);
  near(velocity.y, -200 * THROW_SHARE);
});

test("C-SITE-07 a release that is not a moving pointer is a plain drop", () => {
  const moving = samples([980, 100, 300], [1000, 140, 280]);
  assert.ok(throwVelocity(moving, 1004), "the same movement throws when released at once");
  assert.equal(throwVelocity(moving, undefined), null, "keyboard, cancel and blur carry no time");
  assert.equal(throwVelocity(moving, 1070), null, "the pointer stopped before letting go");
  assert.equal(throwVelocity(samples([1000, 140, 280]), 1004), null, "one position has no direction");
  assert.equal(throwVelocity(samples([900, 100, 300], [1000, 105, 300]), 1004), null, "too slow to be a throw");
  assert.equal(throwVelocity(samples([1000, 0, 0], [1000, 50, 0]), 1000), null, "no time passed");
});

test("C-SITE-07 a hard flick keeps its direction at the low speed limit", () => {
  const velocity = throwVelocity(samples([950, 0, 0], [1000, 300, -400]), 1000);
  near(Math.hypot(velocity.x, velocity.y), MAX_THROW_SPEED);
  near(velocity.x / velocity.y, -0.75);
});

test("C-SITE-07 a released robot keeps its motion, ignores steering and stops at the edge without rebounding", () => {
  const world = thrownWorld();
  world.dropFromPickup({ x: 400, y: -100 });
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
  world.dropFromPickup({ x: -150, y: -200 });
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
  world.dropFromPickup();
  assert.deepEqual([world.player.vx, world.player.vy, world.player.thrown], [0, 30, false]);
  step(world, 0.2, { axis: 1 });
  assert.equal(world.player.vx, 0);
});
