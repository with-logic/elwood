/** Explicit requests cannot outlive a reset or report superseded failures (landing design). */
import assert from "node:assert/strict";
import test from "node:test";
import { LandingScene } from "../landing-scene.mjs";
import { World } from "../world.mjs";

function sceneFixture(t) {
  const deviceRatio = globalThis.devicePixelRatio;
  globalThis.devicePixelRatio = 1;
  t.after(() => { globalThis.devicePixelRatio = deviceRatio; });
  const gates = [], errors = [];
  const scene = Object.create(LandingScene.prototype);
  Object.assign(scene, {
    bank: {
      prepare() {
        const gate = Promise.withResolvers();
        gates.push(gate);
        return gate.promise;
      },
      retainPoses() {},
    },
    world: new World(), ready: true, requestVersion: 0, pressed: {},
    pauses: new Set(), canvas: {}, tether: {},
    director: { interact() {}, resume() {} },
    config: { width: 1000, height: 800, scale: 1.5, floorY: 620, robotX: 500, platforms: [] },
    start() {}, paint() {}, settle() {}, markGround() {}, standingTop() { return 0; },
    onError(error) { errors.push(error.message); },
  });
  return { scene, gates, errors };
}

for (const reset of [false, true]) {
  test(`${reset ? "reset" : "responsive reflow"} drops pending explicit input`, async (t) => {
    const { scene, gates } = sceneFixture(t);
    const pending = scene.request({ gesture: "wave" });
    const version = scene.requestVersion;
    scene.pressed = { face: "front" };
    scene.world.player.queuedAction = { gesture: "wave" };
    scene.configure({ ...scene.config, width: reset ? 1000 : 800 }, reset);
    assert.ok(scene.requestVersion > version);
    assert.equal(scene.world.player.queuedAction, null);
    assert.deepEqual(scene.pressed, {});
    gates[0].resolve();
    await pending;
    assert.deepEqual(scene.pressed, {}, "late delivery cannot replay into the reset World");
  });
}

test("a superseded failure is silent while the current request still reports its failure", async (t) => {
  const { scene, gates, errors } = sceneFixture(t);
  const stale = scene.request({ gesture: "wave" });
  scene.interact();
  gates[0].reject(new Error("stale wave"));
  await stale;
  assert.deepEqual(errors, []);
  const current = scene.request({ gesture: "shrug" });
  gates[1].reject(new Error("current shrug"));
  await current;
  assert.deepEqual(errors, ["current shrug"]);
});
