import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { angleDelta, nearestAngle } from "../rotation.mjs";
import { FLOOR, HEIGHT, PLATFORM_LAYOUT, World } from "../world.mjs";

// The 4K production masters are the asset pipeline's inputs and are NOT part of
// the deployed site or this repository (see .gitignore). Tests that verify an
// exported sprite against its master therefore run only in a checkout that has
// them; everywhere else they skip instead of failing on a missing file.
const productionMasters = new URL("../assets/production/", import.meta.url);
const hasMasters = existsSync(productionMasters);
const masterTest = hasMasters ? test : test.skip;

const step = (world, seconds, input = {}) => {
  for (let index = 0; index < Math.round(seconds * 120); index++) world.update(1 / 120, input);
};

test("sprint follows its calibrated gait, turns on reversal, and does not boost ordinary jump travel", () => {
  const world = new World();
  world.platforms = [];
  world.clips.run = { frames: 24, fps: 24, move_speed: 144, direction: 1, mirror: true };
  world.angles.run = new Array(24).fill(90);
  step(world, 0.8, { axis: 1, sprint: true });
  assert.equal(world.player.animation, "run");
  const x = world.player.x;
  const phase = world.player.walkPhase;
  step(world, 0.5, { axis: 1, sprint: true });
  assert.ok(Math.abs(world.player.x - x - 72) < 0.01);
  assert.ok(Math.abs(world.player.walkPhase - phase - 12) < 0.01);
  world.canRender = (name) => name !== "run";
  const stalledX = world.player.x;
  step(world, 0.2, { axis: 1, sprint: true });
  assert.equal(world.player.x, stalledX, "Run travel waits for its image page");
  world.canRender = () => true;
  world.update(1 / 120, { axis: -1, sprint: true });
  assert.ok(world.player.turn);
  assert.equal(world.player.vx, 0);
  step(world, 0.8, { axis: -1, sprint: true });
  assert.equal(world.player.animation, "run");
  assert.equal(world.player.facing, -1);
  step(world, 0.3, { axis: -1 });
  assert.equal(world.player.animation, "walk-left");
  assert.equal(world.player.turn, null);
  world.update(1 / 120, { axis: -1, sprint: true, jumpPressed: true });
  step(world, 0.5, { axis: -1, sprint: true });
  assert.equal(world.player.mode, "air");
  assert.ok(Math.abs(world.player.vx) <= 72);
});

test("pickup release falls into its dedicated landing and completes recovery before moving", () => {
  const world = new World();
  world.platforms = [];
  world.clips["pickup-fall"] = { frames: 1, fps: 24 };
  world.clips["hero-land"] = { frames: 48, fps: 24, finish_before_next: true };
  world.gestureDurations["hero-land"] = 2;
  world.player.y = FLOOR - 130;
  world.dropFromPickup();
  assert.equal(world.player.animation, "pickup-fall");
  step(world, 0.6, { axis: -1 });
  assert.equal(world.player.gesture, "hero-land");
  assert.equal(world.player.y, FLOOR);
  assert.equal(
    world.player.animation,
    "hero-land",
    "Opposite input during a drop must not turn the landing crouch",
  );
  assert.equal(world.player.facing, 1);
  const x = world.player.x;
  step(world, 0.7, { axis: 1 });
  assert.equal(world.player.x, x);
  assert.equal(world.player.animation, "hero-land");
  step(world, 2, { axis: 1 });
  assert.equal(world.player.gesture, null);
  assert.ok(world.player.x > x);
  world.dropFromPickup();
  world.grab({ edge: 300, platform: { x: 300, width: 100, top: FLOOR - 200 }, direction: 1 });
  assert.equal(world.player.dropLanding, false, "Catching a ledge ends the pickup fall");
  world.release();
  assert.equal(world.player.animation, "jump");
  step(world, 0.1, { axis: 1 });
  assert.ok(world.player.vx > 0, "A later ledge drop uses ordinary air steering");
  world.reset();
  assert.equal(world.player.dropLanding, false);
});

test("idle reverses at both ends without skipping or duplicating the endpoint frames", () => {
  const world = new World();
  const frames = Array.from({ length: 17 }, (_, tick) => {
    world.player.animationTime = tick / 24;
    return world.frameIndex(5);
  });
  assert.deepEqual(frames, [0, 1, 2, 3, 4, 3, 2, 1, 0, 1, 2, 3, 4, 3, 2, 1, 0]);
  world.player.animationTime = 71 / 24;
  assert.equal(
    world.frameIndex(72, 1 / 24),
    70,
    "Render interpolation must also follow the reverse leg",
  );
  for (const name of ["idle", "idle-left", "idle-right", "idle-front", "idle-back"]) {
    world.player.animation = name;
    assert.equal(world.frameIndex(1, 1 / 60), 0, "A one-frame stance must remain valid");
  }
});

test("shrug plays once at twice the source speed and finishes in about 2.33 seconds", () => {
  const world = new World();
  world.gestureDurations.shrug = 112 / 24;
  world.update(1 / 120, { gesture: "shrug" });
  assert.equal(world.player.animation, "shrug");
  step(world, 1);
  assert.equal(world.frameIndex(112), 48);
  step(world, 1.2);
  assert.equal(world.player.gesture, "shrug");
  assert.equal(world.frameIndex(112), 105);
  step(world, 0.15);
  assert.equal(
    world.player.gesture,
    null,
    "The faster clip must exit instead of looping a second time",
  );
});

test("one-shot gestures hold their final image when the interpolated render time reaches the end", () => {
  const world = new World();
  world.player.animation = "thinking";
  world.player.animationTime = 110 / 24 - 1 / 240;
  assert.equal(world.frameIndex(110, 1 / 120), 109);
});

test("walking stops and resumes without a turn at any phase of either real gait", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../assets/game/manifest.json", import.meta.url)),
  );
  for (const facing of [-1, 1]) {
    const direction = facing === -1 ? "left" : "right";
    const walk = `walk-${direction}`;
    const idle = `idle-${direction}`;
    for (let phase = 0; phase < manifest.clips[walk].frames; phase++) {
      const world = new World();
      Object.assign(world, {
        clips: manifest.clips,
        angles: manifest.angles,
        rotationAngles: manifest.rotation_angles,
        walkStarts: manifest.walk_starts,
      });
      step(world, 0.6, { axis: facing });
      assert.equal(world.player.animation, walk);
      assert.ok((world.player.x - 260) * facing > 0);
      world.player.walkPhase = phase;
      for (let tick = 0; tick < 60; tick++) {
        world.update(1 / 120);
        assert.equal(world.player.turn, null, `Stopping ${walk} at phase ${phase} must not rotate`);
        assert.equal(world.player.facing, facing);
      }
      assert.equal(world.player.animation, idle);
      assert.equal(world.player.vx, 0);
      world.update(1 / 120, { axis: facing });
      assert.equal(world.player.turn, null, "Resuming the same heading must not rotate either");
      assert.equal(world.player.animation, walk);
      assert.equal(world.player.walkPhase, manifest.walk_starts[walk]);
      world.update(1 / 120, { axis: -facing });
      assert.equal(world.player.animation, "rotation", "An actual reversal must still rotate");
      assert.equal(world.player.turn.facing, -facing);
    }
  }
});

test("jump takes off, lands on a reachable platform, and cannot air-jump", () => {
  const world = new World();
  world.player.x = 450;
  world.update(1 / 120, { axis: 1, jumpPressed: true });
  step(world, 0.3, { axis: 1 });
  const velocity = world.player.vy;
  world.update(1 / 120, { axis: 1, jumpPressed: true });
  assert.ok(world.player.vy > velocity);
  step(world, 0.8, { axis: 1 });
  assert.equal(world.player.support?.id, "step");
  assert.equal(world.player.y, PLATFORM_LAYOUT[0].top);
});

test("solid letter sides stop grounded movement", () => {
  const world = new World();
  step(world, 4, { axis: 1 });
  assert.ok(world.player.x < PLATFORM_LAYOUT[0].x);
  assert.equal(world.player.y, FLOOR);
});

test("ledge grab, climb, landing and drop form a complete navigation chain", () => {
  const world = new World();
  const ledge = PLATFORM_LAYOUT[1];
  Object.assign(world.player, {
    x: ledge.x - 23,
    y: ledge.top + HEIGHT * 0.85,
    mode: "air",
    vy: 0,
    facing: 1,
  });
  world.update(1 / 120, { climbPressed: true });
  assert.equal(world.player.mode, "hang");
  world.update(1 / 120, { climbPressed: true });
  assert.equal(world.player.mode, "climb");
  step(world, 4.3);
  assert.equal(world.player.support?.id, ledge.id);
  assert.equal(world.player.y, ledge.top);
  world.update(1 / 120, { dropPressed: true });
  assert.equal(world.player.mode, "air");
  assert.ok(world.player.x > ledge.x + ledge.width);
});

test("letting go does not immediately catch the same ledge", () => {
  const world = new World();
  const ledge = PLATFORM_LAYOUT[1];
  Object.assign(world.player, {
    x: ledge.x - 23,
    y: ledge.top + HEIGHT * 0.85,
    mode: "air",
    facing: 1,
  });
  world.update(1 / 120, { climbPressed: true });
  world.update(1 / 120, { dropPressed: true });
  step(world, 0.25, { axis: 1 });
  assert.notEqual(world.player.mode, "hang");
  assert.ok(world.player.grabCooldown > 0);
});

test("movement interrupts gestures and a reset clears every transient state", () => {
  const world = new World();
  world.update(1 / 120, { gesture: "wave" });
  step(world, 0.3);
  assert.equal(world.player.animation, "wave");
  step(world, 0.6, { axis: -1 });
  assert.equal(world.player.animation, "walk-left");
  world.reset();
  assert.equal(world.player.x, 260);
  assert.equal(world.player.animation, "idle");
  assert.equal(world.player.ledge, null);
});

test("reversing movement plays a planted full rotation before starting the new walking offset", () => {
  const world = new World();
  world.walkStarts = { "walk-left": 12, "walk-right": 7 };
  step(world, 0.8, { axis: -1 });
  const x = world.player.x;
  world.update(1 / 120, { axis: 1 });
  assert.equal(world.player.animation, "rotation");
  assert.ok(Math.abs(world.player.turn.delta) > 150);
  step(world, 0.25, { axis: 1 });
  assert.equal(world.player.x, x);
  assert.equal(world.player.facing, -1);
  while (world.player.turn) world.update(1 / 120, { axis: 1 });
  assert.equal(world.player.animation, "walk-right");
  assert.equal(world.frameIndex(36), 7);
});

test("one second of walking matches the roughly 70 pixel source foot travel", () => {
  for (const axis of [-1, 1]) {
    const world = new World();
    step(world, 0.7, { axis });
    const start = world.player.x;
    step(world, 1, { axis });
    const distance = Math.abs(world.player.x - start);
    assert.ok(distance >= 60 && distance <= 76, `Footage-paced walk travelled ${distance}px`);
  }
});

test("touchdown plants both directions before held movement or turning resumes", () => {
  for (const facing of [-1, 1]) {
    const world = new World();
    Object.assign(world.player, {
      x: 350,
      y: FLOOR - 1,
      mode: "air",
      vy: 200,
      vx: facing * 180,
      facing,
    });
    world.update(1 / 120, { axis: facing });
    const touchdown = world.player.x;
    assert.equal(world.player.animation, "land");
    assert.equal(world.player.vx, 0);
    world.update(1 / 120, { axis: -facing, jumpPressed: true });
    step(world, 0.2, { axis: -facing });
    assert.equal(
      world.player.x,
      touchdown,
      "The planted foot must stay fixed even with a direction held",
    );
    assert.equal(world.player.facing, facing, "Landing must not flip halfway through the plant");
    assert.equal(world.player.mode, "ground");
    step(world, 0.4, { axis: facing });
    assert.equal(world.player.animation, facing === 1 ? "walk-right" : "walk-left");
    assert.ok((world.player.x - touchdown) * facing > 0);
  }
});

test("climbing keeps its final stance until a planted turn leads into walking", () => {
  for (const facing of [-1, 1]) {
    const world = new World();
    const platform = PLATFORM_LAYOUT[1];
    world.player.facing = facing;
    world.grab({
      platform,
      edge: facing === 1 ? platform.x : platform.x + platform.width,
      direction: facing,
    });
    world.update(1 / 120, { climbPressed: true });
    step(world, 4.4);
    assert.equal(world.player.animation, "climb-rest");
    const x = world.player.x;
    world.update(1 / 120, { axis: facing });
    assert.equal(world.player.animation, "rotation");
    assert.ok(
      Math.abs(world.player.turn.delta) <= 30,
      "A forward climb must not finish with an about-face",
    );
    step(world, world.player.turn.duration / 2, { axis: facing });
    assert.equal(world.player.x, x);
    assert.equal(world.player.facing, facing);
    step(world, 0.5, { axis: facing });
    assert.equal(world.player.animation, facing === 1 ? "walk-right" : "walk-left");
  }
});

test("front and rear stances persist at rest and movement restores a side-facing gait", () => {
  const world = new World();
  for (const facing of ["front", "back"]) {
    world.update(1 / 120, { face: facing });
    step(world, 0.5);
    assert.equal(world.player.animation, `idle-${facing}`);
    assert.equal(world.player.vx, 0);
    step(world, 0.5, { axis: -1 });
    assert.equal(world.player.animation, "walk-left");
  }
  world.reset();
  assert.equal(world.player.animation, "idle");
});

test("turning back after a climb faces the opposite direction and a jump press survives the turn", () => {
  for (const facing of [-1, 1]) {
    const world = new World();
    Object.assign(world.player, { facing, restAnimation: "climb-rest", animation: "climb-rest" });
    const x = world.player.x;
    world.update(1 / 120, { axis: -facing, jumpPressed: true });
    assert.equal(world.player.animation, "rotation");
    step(world, 0.06, { axis: -facing });
    assert.equal(world.player.x, x);
    assert.equal(world.player.facing, facing);
    step(world, 0.45, { axis: -facing });
    assert.equal(world.player.facing, -facing);
    assert.equal(world.player.mode, "air");
    assert.equal(world.player.animation, "jump");
  }
});

test("the complete letter route is reachable using only movement, jump and climb inputs", () => {
  const world = new World();
  const visited = new Set();
  const manifest = JSON.parse(
    readFileSync(new URL("../assets/game/manifest.json", import.meta.url)),
  );
  Object.assign(world, {
    angles: manifest.angles,
    rotationAngles: manifest.rotation_angles,
    clips: manifest.clips,
    walkStarts: manifest.walk_starts,
    climbExit: { x: manifest.climb_exit.x * HEIGHT, y: manifest.climb_exit.y * HEIGHT },
  });
  let jumping = false;
  for (let tick = 0; tick < 120 * 48; tick++) {
    const player = world.player;
    const next = PLATFORM_LAYOUT.find((platform) => platform.x > player.x);
    const jump = player.mode === "ground" && next && next.x - player.x < 44 && !jumping;
    if (jump) jumping = true;
    if (player.mode === "air") jumping = false;
    world.update(1 / 120, { axis: 1, jumpPressed: jump, climbPressed: player.mode === "hang" });
    if (player.support) visited.add(player.support.id);
  }
  assert.deepEqual(
    [...visited],
    PLATFORM_LAYOUT.map((platform) => platform.id),
  );
  assert.ok(world.player.x > PLATFORM_LAYOUT.at(-1).x + PLATFORM_LAYOUT.at(-1).width);
});

test("jumping never boosts horizontal speed above the walking cadence", () => {
  for (const axis of [-1, 1]) {
    const world = new World();
    Object.assign(world.player, {
      x: 350,
      facing: axis,
      desiredFacing: axis,
      animation: axis === 1 ? "idle-right" : "idle-left",
      hasMoved: true,
    });
    world.update(1 / 120, { jumpPressed: true, axis });
    let airborne = 0;
    for (let i = 0; i < 140; i++) {
      world.update(1 / 120, { axis });
      assert.ok(Math.abs(world.player.vx) <= 72.001);
      if (world.player.mode === "air") airborne++;
    }
    assert.ok(airborne > 50, "The speed check must include a real jump");
  }
});

test("a jump just after leaving a platform retains its short grace window", () => {
  const world = new World();
  Object.assign(world.player, { mode: "air", y: 500, vy: 30, coyote: 0.08 });
  world.update(1 / 120, { jumpPressed: true });
  assert.ok(world.player.vy < -500);
  const vy = world.player.vy;
  world.update(1 / 120, { jumpPressed: true });
  assert.ok(world.player.vy > vy, "The grace jump cannot be repeated in the air");
});

test("a side-facing robot takes only the partial turn into the next gesture", () => {
  const world = new World();
  step(world, 0.8, { axis: -1 });
  step(world, 0.2);
  world.update(1 / 120, { gesture: "thinking" });
  assert.equal(world.player.animation, "rotation");
  assert.ok(Math.abs(world.player.turn.from + 90) < 1);
  assert.ok(Math.abs(world.player.turn.delta - 60) < 1);
  const x = world.player.x;
  step(world, 0.1);
  assert.equal(world.player.x, x);
  step(world, 0.15);
  assert.equal(world.player.animation, "thinking");
  assert.ok(world.player.animationTime < 0.15, "The gesture starts after its turn");
});

test("retargeting a turn continues from its current angle rather than snapping to an endpoint", () => {
  const world = new World();
  step(world, 0.6, { axis: 1 });
  step(world, 0.2, { axis: -1 });
  const before = world.currentYaw();
  const x = world.player.x;
  world.update(1 / 120, { axis: 1 });
  assert.ok(Math.abs(world.currentYaw() - before) < 5);
  assert.equal(world.player.x, x);
  step(world, 0.6, { axis: 1 });
  assert.equal(world.player.animation, "walk-right");
});

test("rotation holds its angle while a needed image page is loading", () => {
  const world = new World();
  world.canRender = () => false;
  world.update(1 / 120, { axis: -1 });
  const angle = world.currentYaw();
  step(world, 0.5, { axis: -1 });
  assert.equal(world.currentYaw(), angle);
  assert.equal(world.player.x, 260);
  world.canRender = () => true;
  step(world, 0.6, { axis: -1 });
  assert.equal(world.player.animation, "walk-left");
});

test("tiptoe moves slowly in the facing direction and movement cancels the performance", () => {
  for (const facing of [-1, 1]) {
    const world = new World();
    Object.assign(world.player, { facing, desiredFacing: facing });
    world.update(1 / 120, { gesture: "tiptoe" });
    step(world, 0.7);
    const x = world.player.x;
    const phase = world.player.gesturePhase;
    step(world, 1);
    assert.ok(Math.abs((world.player.x - x) * facing - 36) < 0.1);
    assert.ok(Math.abs(world.player.gesturePhase - phase - 24) < 0.1);
    world.update(1 / 120, { axis: -facing });
    assert.equal(world.player.gesture, null);
    assert.equal(world.player.animation, "rotation");
  }
});

test("stationary personality performances preserve position, finish, and can be interrupted", () => {
  for (const gesture of ["balance"]) {
    const world = new World();
    world.gestureDurations[gesture] = 6;
    const x = world.player.x;
    world.update(1 / 120, { gesture });
    step(world, 1);
    assert.equal(world.player.gesture, gesture);
    assert.equal(world.player.animation, gesture);
    assert.equal(world.player.x, x);
    step(world, 6);
    assert.equal(world.player.gesture, null);
    world.update(1 / 120, { gesture });
    step(world, 0.5);
    world.update(1 / 120, { jumpPressed: true });
    assert.equal(world.player.gesture, null);
    step(world, 0.8);
    assert.equal(world.player.animation, "jump");
  }
});

test("completed gestures rest at the nearest available ending angle until another action", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../assets/game/manifest.json", import.meta.url)),
  );
  for (const gesture of ["wave", "balance"])
    for (const facing of [-1, 1]) {
      const world = new World();
      Object.assign(world, {
        clips: manifest.clips,
        angles: manifest.angles,
        rotationAngles: manifest.rotation_angles,
      });
      Object.assign(world.player, { facing, desiredFacing: facing, hasMoved: true });
      world.gestureDurations[gesture] = manifest.clips[gesture].frames / 24;
      world.update(1 / 120, { gesture });
      step(world, 8);
      const ending = world.poseYaw(gesture, facing, manifest.angles[gesture].length - 1);
      assert.equal(
        world.player.turn,
        null,
        "An ending gesture must not turn itself to a side idle",
      );
      assert.equal(world.player.animation, "rotation");
      assert.equal(
        world.frameIndex(manifest.rotation_angles.length),
        nearestAngle(manifest.rotation_angles, ending),
      );
      assert.ok(Math.abs(angleDelta(ending, world.currentYaw())) < 4);
      step(world, 2);
      assert.equal(world.player.turn, null);
      world.update(1 / 120, { axis: -facing });
      assert.ok(world.player.turn, "A new movement request can turn away from the resting angle");
    }
});

test("held gestures stay seated or folded indefinitely and recover before a queued jump", () => {
  for (const gesture of ["crossed-arms", "criss-cross"]) {
    const world = new World();
    world.clips[gesture] = { frames: 144, fps: 24, direction: 0, hold_frame: 90 };
    world.gestureDurations[gesture] = 6;
    world.update(1 / 120, { gesture });
    step(world, 20);
    assert.equal(world.player.gesture, gesture);
    assert.equal(world.player.gestureStage, "hold");
    assert.equal(world.frameIndex(144, 1 / 60), 90);
    const x = world.player.x;
    world.update(1 / 120, { jumpPressed: true, axis: 1 });
    step(world, 0.8, { axis: 1 });
    assert.equal(world.player.animation, gesture, "Recovery must play before the requested jump");
    assert.equal(world.player.mode, "ground");
    assert.equal(world.player.x, x, "Never slide a folded or seated robot");
    assert.ok(world.frameIndex(144) > 90);
    step(world, 1.9, { axis: 1 });
    assert.equal(world.player.mode, "air", "The single jump press must survive recovery");
  }
});

test("full-body tricks finish their recovery before facing, walking or jumping", () => {
  for (const input of [{ face: "back" }, { axis: -1 }, { jumpPressed: true }]) {
    const world = new World();
    world.clips.wave = { frames: 48, fps: 24, direction: 0, finish_before_next: true };
    world.gestureDurations.wave = 2;
    world.update(1 / 120, { gesture: "wave" });
    step(world, 0.6);
    const x = world.player.x;
    const facing = world.player.facing;
    world.update(1 / 120, input);
    step(world, 0.6, input.axis ? input : {});
    assert.equal(world.player.animation, "wave", "The trick must finish before the next action");
    assert.equal(world.player.x, x);
    assert.equal(world.player.facing, facing);
    step(world, 1.6, input.axis ? input : {});
    assert.equal(world.player.gesture, null);
    if (input.face) assert.equal(world.player.animation, "idle-back");
    if (input.axis) assert.equal(world.player.animation, "walk-left");
    if (input.jumpPressed) assert.equal(world.player.mode, "air");
  }
});

test("pond hops travel during flight and plant between hops in either direction", () => {
  for (const facing of [-1, 1]) {
    const world = new World();
    Object.assign(world.player, { facing, desiredFacing: facing });
    world.clips["pond-hops"] = {
      frames: 144,
      fps: 24,
      direction: 1,
      travel_speed: Array.from({ length: 144 }, (_, i) => (i < 24 || i >= 48 ? 0 : 40)),
    };
    world.update(1 / 120, { gesture: "pond-hops" });
    while (world.player.turn) world.update(1 / 120);
    const x = world.player.x;
    step(world, 0.8);
    assert.equal(world.player.x, x);
    step(world, 1);
    assert.ok((world.player.x - x) * facing > 28);
    step(world, 0.5);
    const landed = world.player.x;
    step(world, 0.5);
    assert.equal(world.player.x, landed);
  }
});

test("a travelling gesture pauses both motion and its clock while its next image loads", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../assets/game/manifest.json", import.meta.url)),
  );
  const world = new World();
  Object.assign(world, {
    clips: manifest.clips,
    angles: manifest.angles,
    rotationAngles: manifest.rotation_angles,
  });
  world.update(1 / 120, { gesture: "pond-hops" });
  for (let i = 0; i < 600 && world.player.vx === 0; i++) world.update(1 / 120);
  assert.ok(world.player.vx > 0);
  const { x, gestureElapsed } = world.player;
  world.canRender = (name) => name !== "pond-hops";
  step(world, 0.5);
  assert.equal(world.player.x, x);
  assert.equal(world.player.gestureElapsed, gestureElapsed);
  world.canRender = () => true;
  step(world, 0.1);
  assert.ok(world.player.x > x);
  assert.ok(world.player.gestureElapsed > gestureElapsed);
});

test("a later request replaces a queued gesture while a held pose recovers", () => {
  const world = new World();
  world.clips["crossed-arms"] = { frames: 144, fps: 24, direction: 0, hold_frame: 90 };
  world.update(1 / 120, { gesture: "crossed-arms" });
  step(world, 8);
  world.update(1 / 120, { gesture: "wave" });
  step(world, 0.3);
  assert.equal(world.player.animation, "crossed-arms");
  world.update(1 / 120, { face: "back" });
  step(world, 3);
  assert.equal(world.player.animation, "idle-back");
  assert.equal(world.player.gesture, null);
  assert.equal(world.player.queuedAction, null);
});

test("release without a next action recovers to the same facing and reset clears queued actions", () => {
  const world = new World();
  world.clips["criss-cross"] = { frames: 240, fps: 24, direction: 0, hold_frame: 137 };
  world.gestureDurations["criss-cross"] = 10;
  world.update(1 / 120, { gesture: "criss-cross" });
  step(world, 12);
  world.update(1 / 120, { gesture: "wave" });
  world.update(1 / 120, { releaseGesture: true });
  step(world, 5);
  assert.equal(world.player.animation, "rotation");
  assert.equal(world.player.turn, null);
  assert.equal(world.player.x, 260);
  world.update(1 / 120, { gesture: "criss-cross" });
  step(world, 8);
  world.update(1 / 120, { gesture: "wave" });
  world.reset();
  step(world, 12);
  assert.equal(world.player.animation, "idle");
  assert.equal(world.player.queuedAction, null);
  assert.equal(world.player.gestureStage, null);
});

test("stepping off a platform waits for a held sitting pose to stand up", () => {
  const world = new World();
  const support = PLATFORM_LAYOUT[1];
  Object.assign(world.player, { x: support.x + 50, y: support.top, support });
  world.clips["criss-cross"] = { frames: 144, fps: 24, direction: 0, hold_frame: 90 };
  world.update(1 / 120, { gesture: "criss-cross" });
  step(world, 8);
  world.update(1 / 120, { dropPressed: true });
  step(world, 1);
  assert.equal(world.player.animation, "criss-cross");
  assert.equal(world.player.support, support);
  step(world, 1.4);
  assert.equal(world.player.mode, "air");
  assert.equal(world.player.support, null);
});

test("climb playback and completion use the loaded take’s frame count and cadence", () => {
  const world = new World();
  world.clips.climb = { frames: 96, fps: 32 };
  const platform = PLATFORM_LAYOUT[1];
  world.grab({ platform, edge: platform.x, direction: 1 });
  world.update(1 / 120, { climbPressed: true });
  step(world, 1);
  assert.equal(world.frameIndex(96), 32);
  step(world, 1.8);
  assert.equal(world.player.mode, "climb");
  assert.equal(world.frameIndex(96), 89);
  step(world, 0.3);
  assert.equal(world.player.mode, "ground");
  assert.equal(world.player.animation, "climb-rest");
});

test("a hovering gesture loops its middle frames forward and backward without returning to the floor", () => {
  const world = new World();
  const manifest = JSON.parse(
    readFileSync(new URL("../assets/game/manifest.json", import.meta.url)),
  );
  world.clips["zero-gravity"] = manifest.clips["zero-gravity"];
  const [start, end] = world.clips["zero-gravity"].hold_loop;
  assert.ok(
    start >= 60 && end <= 80,
    "The hover must stay inside the visually reviewed bent-knee poses",
  );
  world.gestureDurations["zero-gravity"] = 6;
  world.update(1 / 120, { gesture: "zero-gravity" });
  step(world, 5);
  assert.equal(world.player.gestureStage, "hold");
  let previous = world.frameIndex(144);
  let forward = 0;
  let backward = 0;
  let direction = world.player.gestureDirection;
  const reversals = [];
  for (let i = 0; i < 24 * 20; i++) {
    step(world, 1 / 24);
    if (world.player.gestureDirection !== direction) {
      reversals.push(world.time);
      direction = world.player.gestureDirection;
    }
    const frame = world.frameIndex(144);
    const interpolated = world.frameIndex(144, 1 / 60);
    assert.ok(frame >= start && frame <= end);
    assert.ok(interpolated >= start && interpolated <= end);
    assert.ok(Math.abs(frame - previous) <= 1, `Hover jumped from ${previous} to ${frame}`);
    forward += frame > previous;
    backward += frame < previous;
    previous = frame;
  }
  assert.ok(forward >= 3 * (end - start) && backward >= 3 * (end - start));
  assert.ok(reversals.length >= 6);
  for (let i = 2; i < reversals.length; i++) {
    assert.ok(
      Math.abs(reversals[i] - reversals[i - 2] - (2 * (end - start)) / 24) < 1 / 24,
      "The bent-knee hover must play at normal source speed",
    );
  }
  assert.equal(world.player.gesture, "zero-gravity");
  assert.equal(world.player.x, 260);
  assert.equal(world.player.y, FLOOR);
});

test("leaving a reversed hover continues from its displayed pose and lands before a queued jump", () => {
  const world = new World();
  const manifest = JSON.parse(
    readFileSync(new URL("../assets/game/manifest.json", import.meta.url)),
  );
  world.clips["zero-gravity"] = manifest.clips["zero-gravity"];
  world.gestureDurations["zero-gravity"] = 6;
  world.update(1 / 120, { gesture: "zero-gravity" });
  for (let i = 0; i < 1200 && world.player.gestureDirection === 1; i++) world.update(1 / 120);
  step(world, 0.35);
  assert.equal(world.player.gestureDirection, -1);
  const frame = world.frameIndex(144);
  world.update(1 / 120, { jumpPressed: true });
  assert.equal(world.player.gestureStage, "exit");
  assert.ok(Math.abs(world.frameIndex(144) - frame) <= 1, "Exit must not reset to a loop boundary");
  const elapsed = world.player.gestureElapsed;
  world.canRender = (name) => name !== "zero-gravity";
  step(world, 0.5);
  assert.equal(world.player.gestureElapsed, elapsed, "Recovery waits for the next sprite page");
  world.canRender = () => true;
  step(world, 1);
  assert.equal(world.player.gesture, "zero-gravity");
  assert.equal(world.player.mode, "ground");
  assert.ok(
    Math.abs(world.player.gestureElapsed - elapsed - 1) < 1 / 120,
    "Landing must return to normal source speed",
  );
  for (let i = 0; i < 600 && world.player.gesture; i++) world.update(1 / 120);
  assert.equal(world.player.gesture, null);
  for (let i = 0; i < 120 && world.player.mode === "ground"; i++) world.update(1 / 120);
  assert.equal(
    world.player.mode,
    "air",
    "The queued jump must survive its orientation bridge and preparation",
  );
});

test("faint stays on the ground until a new action requests its standing recovery", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../assets/game/manifest.json", import.meta.url)),
  );
  const world = new World();
  Object.assign(world, {
    clips: manifest.clips,
    angles: manifest.angles,
    rotationAngles: manifest.rotation_angles,
  });
  world.update(1 / 120, { gesture: "dramatic-faint" });
  step(world, 30);
  assert.equal(world.player.gestureStage, "hold");
  assert.equal(world.frameIndex(144), 101);
  world.update(1 / 120, { face: "back" });
  step(world, 1);
  assert.equal(world.player.gesture, "dramatic-faint", "Get up before rotating");
  step(world, 2);
  assert.equal(world.player.animation, "idle-back");
});

masterTest(
  "the cartwheel cancels its measured contact sweep and ends at its new position in both directions",
  () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../assets/game/manifest.json", import.meta.url)),
    );
    const motion = JSON.parse(
      readFileSync(new URL("../assets/production/ground-motion.json", import.meta.url)),
    )["32-cartwheel"];
    const atlas = JSON.parse(
      readFileSync(
        new URL("../assets/production/sprites/32-cartwheel/atlas.json", import.meta.url),
      ),
    );
    const expected =
      (((motion.offset_x.at(-1) * atlas.source_size.w) / motion.source_width) * HEIGHT) /
      atlas.standing_height_source_px;
    assert.ok(expected > 95 && expected < 110);
    for (const facing of [-1, 1]) {
      const world = new World();
      Object.assign(world, {
        clips: manifest.clips,
        angles: manifest.angles,
        rotationAngles: manifest.rotation_angles,
      });
      Object.assign(world.player, { facing, desiredFacing: facing });
      world.update(1 / 120, { gesture: "cartwheel" });
      step(world, 1.5);
      assert.ok((world.player.x - 260) * facing > 5);
      const x = world.player.x;
      const clock = world.player.gestureElapsed;
      world.canRender = (name) => name !== "cartwheel";
      step(world, 0.5);
      assert.equal(world.player.x, x);
      assert.equal(world.player.gestureElapsed, clock);
      world.canRender = () => true;
      step(world, 6);
      assert.ok(Math.abs((world.player.x - 260) * facing - expected) < 0.2);
      assert.equal(world.player.gesture, null);
      const end = world.player.x;
      step(world, 2);
      assert.equal(world.player.x, end, "No snap back after the trick");
    }
  },
);
