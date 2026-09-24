/** Explicit requests cannot outlive reset or report superseded failures (PRD §13; site/docs/design/landing.md). */
import assert from "node:assert/strict";
import test from "node:test";
import { NO_INPUT } from "../autonomy.mjs";
import { LandingScene } from "../landing-scene.mjs";
import { SpriteBank } from "../sprite-bank.mjs";
import { World } from "../world.mjs";

const turn = () => new Promise((resolve) => setImmediate(resolve));

function sceneFixture(t) {
  const deviceRatio = globalThis.devicePixelRatio;
  globalThis.devicePixelRatio = 1;
  t.after(() => { globalThis.devicePixelRatio = deviceRatio; });
  const gates = [], errors = [], signals = [];
  const scene = Object.create(LandingScene.prototype);
  Object.assign(scene, {
    bank: {
      prepare(_name, { signal } = {}) {
        const gate = Promise.withResolvers();
        gates.push(gate);
        signals.push(signal);
        return gate.promise;
      },
      retainPoses() {},
    },
    world: new World(), ready: true, requestVersion: 0, pressed: NO_INPUT,
    pauses: new Set(), canvas: {}, tether: {},
    director: { interact() {}, resume() {} },
    config: { width: 1000, height: 800, scale: 1.5, floorY: 620, robotX: 500, platforms: [] },
    start() {}, paint() {}, settle() {}, markGround() {}, standingTop() { return 0; },
    onError(error) { errors.push(error.message); },
  });
  return { scene, gates, errors, signals };
}

for (const reset of [false, true]) {
  test(`${reset ? "reset" : "responsive reflow"} drops pending explicit input`, async (t) => {
    const { scene, gates, signals } = sceneFixture(t);
    const pending = scene.request({ gesture: "wave" });
    scene.world.player.queuedAction = { gesture: "wave" };
    scene.configure({ ...scene.config, width: reset ? 1000 : 800 }, reset);
    assert.equal(scene.world.player.queuedAction, null);
    assert.equal(signals[0].aborted, true, "reconfiguration releases the explicit sprite load");
    gates[0].resolve();
    await pending;
    assert.equal(scene.pressed, NO_INPUT, "late delivery cannot replay into the reset World");
  });

  test(`${reset ? "reset" : "responsive reflow"} restores the inactive input sentinel`, (t) => {
    const { scene } = sceneFixture(t);
    scene.pressed = { face: "front" };
    scene.configure({ ...scene.config, width: reset ? 1000 : 800 }, reset);
    assert.equal(scene.pressed, NO_INPUT);
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

test("superseding a shared explicit load restores the automatic failure reporter", async (t) => {
  const { scene, errors } = sceneFixture(t);
  const originalFetch = globalThis.fetch;
  const gate = Promise.withResolvers();
  let calls = 0;
  globalThis.fetch = () => { calls++; return gate.promise; };
  const bank = new SpriteBank((error) => errors.push(error.message));
  t.after(() => { bank.dispose(); globalThis.fetch = originalFetch; });
  scene.bank = bank;
  bank.frame("wave", 0);
  await turn();
  const pending = scene.request({ gesture: "wave" });
  await turn();
  scene.interact();
  gate.reject(new Error("automatic asset failed"));
  await pending;
  await turn();
  assert.equal(calls, 1, "both consumers joined one sprite task");
  assert.equal(errors.length, 1);
  assert.match(errors[0], /wave\/clip.json/);
  bank.frame("wave", 0);
  await turn();
  assert.equal(calls, 1, "automatic failure stays latched");
});
