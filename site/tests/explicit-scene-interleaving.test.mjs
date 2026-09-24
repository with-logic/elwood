/** Landing preparation and World ownership interleavings (PRD §13.1, C-SITE-01). */
import assert from "node:assert/strict";
import test from "node:test";
import { Autonomy, NO_INPUT } from "../autonomy.mjs";
import { waitFor } from "./animation-fixture.mjs";
import { sceneFixture } from "./explicit-scene-fixture.mjs";

async function jumpAssets(bank, scene) {
  await bank.prepareAnimation("jump");
  bank.publishAnimation("jump");
  bank.activateAnimation("jump");
  scene.world.rotationAngles = [0, 60];
}
function reachJump(scene, phase) {
  for (let i = 0; i < 120 && !(phase === "pending" ? scene.world.player.pendingJump : scene.world.player.prepare > 0); i++)
    scene.step(1 / 120);
  assert.equal(scene.world.player.mode, "ground");
  assert.ok(phase === "pending" ? scene.world.player.pendingJump : scene.world.player.prepare > 0);
}
for (const phase of ["pending", "prepare"]) {
  test(`C-SITE-01 ${phase} jump rejects a new animation before fetching`, async (t) => {
    const { bank, scene, requested } = sceneFixture(t);
    await jumpAssets(bank, scene);
    await scene.request({ jumpPressed: true });
    reachJump(scene, phase);
    const before = requested.length;
    await scene.request({ face: "back" });
    assert.equal(requested.length, before);
    assert.equal(scene.pressed.face, undefined);
    assert.equal(bank.animations.deliveredOwner, null);
  });

  test(`C-SITE-01 jump entering ${phase} during loading cancels delivery`, async (t) => {
    const { bank, scene, gates, requested } = sceneFixture(t);
    await jumpAssets(bank, scene);
    scene.pressed = { jumpPressed: true };
    const gate = Promise.withResolvers();
    gates.set("wave/5.webp", gate);
    const pending = scene.request({ gesture: "wave" });
    await waitFor(requested, "wave/5.webp");
    reachJump(scene, phase);
    gate.resolve();
    await pending;
    assert.equal(scene.pressed, NO_INPUT);
    assert.equal(bank.animations.candidateOwner, null);
    assert.equal(bank.animations.deliveredOwner, null);
  });
}

test("C-SITE-01 pending loading suppresses real autonomy past its quiet delay", async (t) => {
  const { bank, scene, gates, requested } = sceneFixture(t);
  await bank.prepare("idle");
  scene.director = new Autonomy();
  scene.visibleBounds = { left: 20, right: 1000 };
  gates.set("wave/5.webp", Promise.withResolvers());
  const pending = scene.request({ gesture: "wave" });
  await waitFor(requested, "wave/5.webp");
  for (let i = 0; i < 1200; i++) scene.step(1 / 120);
  assert.equal(scene.director.quiet, 0);
  assert.equal(scene.director.mode, "manual");
  assert.equal(scene.director.task, null);
  scene.interact();
  await pending;
});

for (const [input, name] of [[{ gesture: "wave" }, "wave"], [{ face: "back" }, "idle-back"]]) {
  test(`C-SITE-01 recovery completion promotes queued ${name} before painting`, async (t) => {
    const { bank, scene } = sceneFixture(t);
    await bank.prepareAnimation("cartwheel");
    bank.publishAnimation("cartwheel");
    bank.activateAnimation("cartwheel");
    scene.world.clips.cartwheel = { finish_before_next: true, frames: 2, fps: 24 };
    scene.world.gestureDurations.cartwheel = 2 / 24;
    scene.world.rotationAngles = [0, 60];
    Object.assign(scene.world.player, { gesture: "cartwheel", gestureStage: "enter", animation: "cartwheel" });
    await scene.request(input);
    const owner = bank.animations.deliveredOwner;
    scene.step(1 / 120);
    assert.equal(bank.animations.deliveredOwner, owner);
    assert.deepEqual(scene.world.player.queuedAction, input);
    for (let i = 0; i < 40 && bank.animations.deliveredOwner; i++) scene.step(1 / 120);
    assert.equal(bank.animations.deliveredOwner, null);
    assert.equal(bank.animations.activeOwner, owner);
    assert.equal(scene.world.player.turn?.target ?? scene.world.player.animation, name);
    assert.equal(bank.frame(name, 0).page, owner.pages.get(`${name}/0`));
    assert.equal(bank.frame(name, 0).page.closed, 0);
  });
}

test("C-SITE-01 supersession preserves an unrelated pending jump", async (t) => {
  const { scene } = sceneFixture(t);
  scene.pressed = { face: "front", jumpPressed: true };
  scene.interact();
  assert.deepEqual(scene.pressed, { jumpPressed: true });
});
