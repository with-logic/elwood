/** Landing input waits for complete preparation (PRD §13; docs/design/landing.md). */
import assert from "node:assert/strict";
import test from "node:test";
import { LandingScene } from "../landing-scene.mjs";
import { fixture, turn, waitFor } from "./animation-fixture.mjs";

function sceneFor(bank) {
  const scene = Object.create(LandingScene.prototype);
  Object.assign(scene, {
    bank, ready: true, requestVersion: 0, pressed: {}, pauses: new Set(), pending: new Set(),
    director: { interact() {} }, start() {}, onError(error) { throw error; },
  });
  return scene;
}

test("lazy entry loading cannot supersede explicit readiness; movement cancels delivery", async (t) => {
  const { bank, gates, requested } = fixture(t);
  const scene = sceneFor(bank);
  gates.set("wave/5.webp", Promise.withResolvers());
  const pending = scene.request({ gesture: "wave" });
  await waitFor(requested, "wave/5.webp");
  scene.prepare("walk");
  await turn();
  assert.equal(scene.pressed.gesture, undefined);
  scene.interact();
  await pending;
  assert.equal(scene.pressed.gesture, undefined);
  const next = scene.request({ face: "back" });
  await next;
  assert.equal(scene.pressed.face, "back");
});

test("delivered input stays ready until activation and later loading preserves active pages", async (t) => {
  const { bank, gates, requested } = fixture(t);
  const scene = sceneFor(bank);
  await scene.request({ gesture: "wave" });
  for (let i = 0; i < 6; i++) assert.equal(bank.frame("wave", i).page.closed, 0);
  gates.set("jump/0.webp", Promise.withResolvers());
  bank.activateAnimation("wave");
  const replacement = scene.request({ gesture: "jump" });
  await waitFor(requested, "jump/0.webp");
  assert.equal(bank.frame("wave", 5).page.closed, 0);
  scene.clearInput();
  await replacement;
  assert.equal(bank.frame("wave", 5).page.closed, 0);
});


test("current preparation failure reaches the controller's error callback", async (t) => {
  const { bank } = fixture(t);
  const scene = sceneFor(bank);
  const errors = [];
  scene.onError = (error) => errors.push(error);
  globalThis.fetch = async () => { throw new Error("asset connection failed"); };
  await scene.request({ gesture: "wave" });
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /idle\/clip.json/);
  assert.equal(errors[0].cause.message, "asset connection failed");
  assert.equal(scene.pressed.gesture, undefined);
});

test("superseded controller delivery suppresses an already failed real preparation", async (t) => {
  const { bank, gates, requested } = fixture(t);
  const scene = sceneFor(bank), errors = [];
  scene.onError = (error) => errors.push(error);
  const failed = Promise.withResolvers(), releaseFailure = Promise.withResolvers();
  const prepare = bank.prepareAnimation.bind(bank);
  bank.prepareAnimation = (name) => name !== "wave" ? prepare(name) : prepare(name).catch(async (error) => {
    // Hold only the rejected delivery boundary; the actual bank/fetch failure still runs.
    failed.resolve(error);
    await releaseFailure.promise;
    throw error;
  });
  const broken = Promise.withResolvers();
  gates.set("wave/0.webp", broken);
  const obsolete = scene.request({ gesture: "wave" });
  await waitFor(requested, "wave/0.webp");
  broken.reject(new Error("obsolete asset failed"));
  assert.equal((await failed.promise).cause.message, "obsolete asset failed");
  await scene.request({ gesture: "jump" });
  releaseFailure.resolve();
  await obsolete;
  assert.deepEqual(errors, []);
  assert.equal(scene.pressed.gesture, "jump");
});
