/** World acceptance determines delivered animation ownership (PRD §13). */
import assert from "node:assert/strict";
import test from "node:test";
import { NO_INPUT } from "../autonomy.mjs";
import { waitFor } from "./animation-fixture.mjs";
import { sceneFixture } from "./explicit-scene-fixture.mjs";

for (const [input, name] of [[{ gesture: "wave" }, "wave"], [{ face: "back" }, "idle-back"]]) {
  test(`held movement discards queued ${name} delivery on a later tick`, async (t) => {
    const { bank, scene, images } = sceneFixture(t);
    scene.world.clips.cartwheel = { finish_before_next: true };
    Object.assign(scene.world.player, { gesture: "cartwheel", gestureStage: "enter", animation: "cartwheel" });
    await scene.request(input);
    scene.step(1 / 120);
    assert.deepEqual(scene.world.player.queuedAction, input);
    const delivered = bank.animations.deliveredOwner;
    assert.equal(delivered?.name, name);
    assert.equal(scene.pressed, NO_INPUT);
    scene.axis = 1;
    scene.step(1 / 120);
    assert.equal(scene.world.player.queuedAction, null);
    assert.equal(bank.animations.deliveredOwner, null);
    assert.equal(delivered.controller.signal.aborted, true);
    for (let i = 0; i < 6; i++) await bank.loadPage("wave", i);
    assert.ok(images.some((image) => image.closed === 1));
    for (const image of images) {
      const retained = image.path.startsWith("idle/") || [...bank.pages.values()].includes(image);
      assert.equal(image.closed, retained ? 0 : 1);
    }
  });
}

for (const state of ["air", "hang", "climb", "landing", "settle", "drag", "movement"]) {
  test(`known dropped ${state} input avoids full preparation`, async (t) => {
    const { bank, scene, requested } = sceneFixture(t);
    if (["landing", "settle"].includes(state)) scene.world.player[state] = 1;
    else if (state === "drag") scene.drag = {};
    else if (state === "movement") scene.axis = 1;
    else scene.world.player.mode = state;
    await scene.request({ gesture: "wave" });
    assert.deepEqual(requested, []);
    assert.equal(scene.pressed, NO_INPUT);
    assert.equal(bank.animations.candidateOwner, null);
  });
}

test("eligibility lost during preparation releases the candidate before delivery", async (t) => {
  const { bank, scene, gates, requested } = sceneFixture(t);
  const gate = Promise.withResolvers();
  gates.set("wave/5.webp", gate);
  const pending = scene.request({ gesture: "wave" });
  await waitFor(requested, "wave/5.webp");
  scene.world.player.mode = "air";
  gate.resolve();
  await pending;
  assert.equal(scene.pressed, NO_INPUT);
  assert.equal(bank.animations.candidateOwner, null);
  assert.equal(bank.animations.deliveredOwner, null);
});

test("held climb does not discard a grounded gesture", async (t) => {
  const { bank, scene } = sceneFixture(t);
  scene.climbHeld = true;
  await scene.request({ gesture: "wave" });
  const owner = bank.animations.deliveredOwner;
  assert.equal(owner?.name, "wave");
  scene.step(1 / 120);
  assert.equal(scene.world.player.gesture, "wave");
  assert.equal(bank.animations.activeOwner, owner);
});
