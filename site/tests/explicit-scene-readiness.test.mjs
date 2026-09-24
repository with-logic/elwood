/** Explicit controls wait for requested and dependency sheets (PRD §13). */
import assert from "node:assert/strict";
import test from "node:test";
import { NO_INPUT } from "../autonomy.mjs";
import { waitFor } from "./animation-fixture.mjs";
import { sceneFixture } from "./explicit-scene-fixture.mjs";

for (const [name, page] of [["wave", 5], ["idle", 1], ["rotation", 1]]) {
  test(`explicit wave waits for the final ${name} sheet and activates before paint`, async (t) => {
    const { bank, scene, gates, requested } = sceneFixture(t);
    const path = `${name}/${page}.webp`, gate = Promise.withResolvers();
    gates.set(path, gate);
    const pending = scene.request({ gesture: "wave" });
    await waitFor(requested, path);
    assert.equal(scene.pressed, NO_INPUT);
    assert.equal(bank.animations.deliveredOwner, null);
    gate.resolve();
    await pending;
    const owner = bank.animations.deliveredOwner;
    assert.equal(owner.name, "wave");
    for (const clipName of ["idle", "rotation", "wave"])
      for (let i = 0; i < owner.clips.get(clipName).pages.length; i++)
        assert.equal(owner.pages.get(`${clipName}/${i}`).closed, 0);
    scene.step(1 / 120);
    assert.equal(scene.world.player.turn.target, "wave");
    assert.equal(bank.animations.activeOwner, owner);
    assert.equal(bank.animations.deliveredOwner, null);
    const image = bank.frame("wave", 5).page;
    scene.clearInput();
    assert.equal(bank.frame("wave", 5).page, image);
    assert.equal(image.closed, 0);
  });
}

test("supersession cancels pending full preparation without delivering stale input", async (t) => {
  const { bank, scene, gates, requested } = sceneFixture(t);
  gates.set("wave/5.webp", Promise.withResolvers());
  const pending = scene.request({ gesture: "wave" });
  await waitFor(requested, "wave/5.webp");
  scene.interact();
  assert.equal(bank.animations.candidateOwner, null);
  await pending;
  assert.equal(scene.pressed, NO_INPUT);
  assert.equal(bank.animations.candidateOwner, null);
  await scene.request({ face: "back" });
  assert.equal(bank.animations.deliveredOwner?.name, "idle-back");
});

for (const phase of ["pending", "delivered"]) {
  test(`reflow releases ${phase} preparation and preserves held movement`, async (t) => {
    const { bank, scene, gates, requested } = sceneFixture(t);
    const ratio = globalThis.devicePixelRatio;
    globalThis.devicePixelRatio = 1;
    t.after(() => { globalThis.devicePixelRatio = ratio; });
    Object.assign(scene, { canvas: {}, tether: {}, paint() {}, settle() {}, markGround() {},
      standingTop() { return 0; },
      config: { width: 1000, height: 800, scale: 1.5, floorY: 620, robotX: 500, platforms: [] },
    });
    if (phase === "pending") gates.set("wave/5.webp", Promise.withResolvers());
    const pending = scene.request({ gesture: "wave" });
    if (phase === "pending") await waitFor(requested, "wave/5.webp");
    else await pending;
    assert.equal((phase === "pending" ? bank.animations.candidateOwner : bank.animations.deliveredOwner)?.name, "wave");
    scene.axis = 1;
    scene.configure({ ...scene.config, width: 800 });
    assert.equal(bank.animations.candidateOwner, null);
    await pending;
    assert.equal(scene.axis, 1);
    assert.equal(scene.pressed, NO_INPUT);
    assert.equal(bank.animations.candidateOwner, null);
    assert.equal(bank.animations.deliveredOwner, null);
  });
}

test("superseding delivered input restores the inactive input sentinel", async (t) => {
  const { bank, scene } = sceneFixture(t);
  await scene.request({ gesture: "wave" });
  assert.equal(bank.deliveredAnimation, "wave");
  scene.interact();
  assert.equal(scene.pressed, NO_INPUT);
  assert.equal(bank.animations.deliveredOwner, null);
});
