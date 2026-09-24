/** Responsive reflow invalidates delivered gesture ownership (PRD §13). */
import assert from "node:assert/strict";
import test from "node:test";
import { LandingScene } from "../landing-scene.mjs";
import { World } from "../world.mjs";
import { fixture, waitFor } from "./animation-fixture.mjs";

for (const reset of [false, true]) for (const phase of ["pending", "delivered"])
test(`${reset ? "reset" : "reflow"} releases ${phase} ownership when World clears recovery`, async (t) => {
  const { bank, images, gates, requested } = fixture(t);
  const ratio = globalThis.devicePixelRatio;
  globalThis.devicePixelRatio = 1;
  t.after(() => { globalThis.devicePixelRatio = ratio; });
  const scene = Object.create(LandingScene.prototype);
  Object.assign(scene, {
    bank, world: new World(), ready: true, requestVersion: 0, pressed: {},
    pauses: new Set(), canvas: {}, tether: {}, director: { interact() {}, resume() {} },
    config: { width: 1000, height: 800, scale: 1.5, floorY: 620, robotX: 500, platforms: [] },
    start() {}, paint() {},
  });
  if (phase === "pending") gates.set("wave/5.webp", Promise.withResolvers());
  const pending = scene.request({ gesture: "wave" });
  if (phase === "pending") await waitFor(requested, "wave/5.webp");
  else await pending;
  const version = scene.requestVersion;
  scene.world.player.queuedAction = { gesture: "wave" };
  scene.pressed = {};
  scene.configure({ ...scene.config, width: reset ? 1000 : 800 }, reset);
  assert.ok(scene.requestVersion > version);
  assert.equal(scene.world.player.queuedAction, null);
  assert.equal(bank.animations.deliveredOwner, null);
  assert.equal(bank.animations.candidateOwner, null);
  await pending;
  assert.equal(scene.pressed.gesture, undefined);
  assert.ok(images.filter((image) => image.path.startsWith("wave/")).every((image) =>
    image.closed === (bank.pages.has(image.path.replace(".webp", "")) ? 0 : 1)));
});
