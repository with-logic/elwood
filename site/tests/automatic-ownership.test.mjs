/** Automatic/manual handoff preserves exact page owners (PRD §13.3, C-SITE-03). */
import assert from "node:assert/strict";
import test from "node:test";
import { automaticScene, moment, turn } from "./automatic-scene-fixture.mjs";

test("C-SITE-03 an automatic cancellation continuation cannot cancel a newer bank owner", async (t) => {
  const { scene, bank, gates, tick } = await automaticScene(t);
  gates.set("wave/5.webp", Promise.withResolvers());
  scene.director.task = moment();
  await tick(20);
  const replacement = bank.prepareAnimation("bow");
  const owner = bank.animations.candidateOwner;
  assert.ok(await replacement);
  assert.equal(bank.animations.candidateOwner, owner);
  assert.equal(owner.controller.signal.aborted, false);
});

test("C-SITE-03 ending queued delivery clears only its matching World action", async (t) => {
  const { scene, bank, tick } = await automaticScene(t);
  await bank.prepareAnimation("cartwheel");
  bank.publishAnimation("cartwheel"); bank.activateAnimation("cartwheel");
  const active = bank.animations.activeOwner;
  scene.world.clips.cartwheel.finish_before_next = true;
  scene.world.gestureDurations.cartwheel = 6;
  Object.assign(scene.world.player, { gesture: "cartwheel", gestureStage: "enter", animation: "cartwheel" });
  scene.director.task = moment();
  await tick(30);
  assert.deepEqual(scene.world.player.queuedAction, { gesture: "wave" });
  assert.equal(bank.animations.deliveredOwner.name, "wave");
  scene.director.rest();
  assert.equal(scene.world.player.queuedAction, null);
  assert.equal(bank.animations.deliveredOwner, null);
  assert.equal(bank.animations.activeOwner, active);
  assert.equal(active.pages.get("cartwheel/0").closed, 0);
  scene.director.task = moment();
  await tick(20);
  assert.equal(bank.animations.deliveredOwner.name, "wave");
  scene.world.player.queuedAction = { jumpPressed: true };
  scene.director.rest();
  assert.deepEqual(scene.world.player.queuedAction, { jumpPressed: true });
});

test("C-SITE-03 a ready automatic owner cannot publish over a newer manual candidate", async (t) => {
  const { scene, bank, tick } = await automaticScene(t);
  scene.director.task = moment();
  const task = scene.director.task;
  await tick();
  scene.step(1 / 120);
  for (let i = 0; i < 100 && !scene.automaticPreparation.owner?.ready; i++) await turn();
  assert.equal(scene.automaticPreparation.owner.ready, true);
  const manual = bank.prepareAnimation("bow");
  const replacement = bank.animations.candidateOwner;
  scene.step(1 / 120);
  assert.equal(task.sent, false);
  assert.equal(scene.world.player.gesture, null);
  assert.equal(replacement.controller.signal.aborted, false);
  assert.ok(await manual);
  assert.equal(bank.animations.candidateOwner, replacement);
});

test("C-SITE-03 an unchanged complete active owner can serve the same automatic action", async (t) => {
  const { scene, bank, tick } = await automaticScene(t);
  await bank.prepareAnimation("wave");
  bank.publishAnimation("wave"); bank.activateAnimation("wave");
  const active = bank.animations.activeOwner;
  Object.assign(scene.world.player, { gesture: "wave", gestureStage: "enter", animation: "wave" });
  scene.director.task = moment();
  await tick(2);
  assert.equal(scene.director.task.sent, true);
  assert.equal(bank.animations.activeOwner, active);
});

test("C-SITE-03 a newer same-name manual recovery queue survives obsolete task cancellation", async (t) => {
  const { scene, bank, tick } = await automaticScene(t);
  await bank.prepareAnimation("cartwheel");
  bank.publishAnimation("cartwheel"); bank.activateAnimation("cartwheel");
  scene.world.clips.cartwheel.finish_before_next = true;
  scene.world.gestureDurations.cartwheel = 6;
  Object.assign(scene.world.player, { gesture: "cartwheel", gestureStage: "enter", animation: "cartwheel" });
  scene.director.task = moment();
  const obsolete = scene.director.task;
  await tick(20);
  const oldOwner = bank.animations.deliveredOwner;
  assert.equal(oldOwner.name, "wave");
  await scene.request({ gesture: "wave" });
  const manual = bank.animations.deliveredOwner;
  assert.notEqual(manual, oldOwner);
  assert.equal(oldOwner.controller.signal.aborted, true);
  await tick();
  assert.deepEqual(scene.world.player.queuedAction, { gesture: "wave" });
  scene.automaticPreparation.cancel(obsolete);
  assert.deepEqual(scene.world.player.queuedAction, { gesture: "wave" });
  assert.equal(bank.animations.deliveredOwner, manual);
  assert.equal(manual.controller.signal.aborted, false);
});

test("C-SITE-03 a stale readiness callback cannot acquire a replacement or disposed task", async (t) => {
  const { scene, bank, requested } = await automaticScene(t);
  const obsolete = moment();
  scene.director.task = obsolete;
  scene.interact();
  const before = requested.length;
  assert.equal(scene.director.ready("wave", obsolete), false);
  assert.equal(bank.animations.candidateOwner, null);
  scene.dispose();
  assert.equal(scene.director.ready("wave", scene.director.task), false);
  assert.equal(requested.length, before);
});
