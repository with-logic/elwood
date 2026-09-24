/** Automatic action deadlines precede asset and geometry work (PRD §13). */
import assert from "node:assert/strict";
import test from "node:test";
import { LandingScene } from "../landing-scene.mjs";
import { fixture, turn, waitFor } from "./animation-fixture.mjs";

async function setup(t) {
  const assets = fixture(t);
  const keys = [
    "document",
    "matchMedia",
    "devicePixelRatio",
    "requestAnimationFrame",
    "cancelAnimationFrame",
  ];
  const original = Object.fromEntries(keys.map((key) => [key, globalThis[key]]));
  const context = new Proxy({}, { get: () => () => {} });
  const canvas = () => ({ getContext: () => context });
  Object.assign(globalThis, {
    document: { createElement: canvas },
    matchMedia: () => ({ matches: false }),
    devicePixelRatio: 1,
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
  });
  const scene = new LandingScene(canvas());
  scene.bank.dispose();
  scene.bank = assets.bank;
  scene.ready = true;
  scene.visibleBounds = { left: 20, right: 1000 };
  scene.world.clips = { wave: { frames: 6, fps: 24 } };
  await scene.bank.prepare("idle");
  t.after(() => {
    scene.dispose();
    Object.assign(globalThis, original);
  });
  return { ...assets, scene };
}

for (const kind of ["moment", "face"]) {
  for (const elapsedSeconds of [7.99, 8, 8.01]) {
    test(`${kind} becoming ready at ${elapsedSeconds}s respects the pre-delivery deadline`, async (t) => {
      const { scene, bank, gates, requested } = await setup(t);
      const name = kind === "moment" ? "wave" : "idle-back";
      const gate = Promise.withResolvers();
      gates.set(`${name}/0.webp`, gate);
      const task = { kind, name, direction: "back", sent: false, elapsedSeconds: 0, hold: 3 };
      scene.director.task = task;
      for (let i = 0; i < 10; i++) {
        scene.step(1 / 120);
        await turn();
      }
      await waitFor(requested, `${name}/0.webp`);
      assert.equal(task.sent, false);
      task.elapsedSeconds = elapsedSeconds - 0.01;
      gate.resolve();
      for (let i = 0; i < 100 && !bank.pages.has(`${name}/0`); i++) await turn();
      assert.ok(
        bank.pages.has(`${name}/0`),
        "Asset readiness changes before the next physics tick",
      );
      scene.step(0.01);
      assert.equal(task.sent, elapsedSeconds <= 8);
      assert.equal(scene.director.task.kind, elapsedSeconds <= 8 ? kind : "rest");
    });
  }
  test(`expired ${kind} does not start asset or geometry work`, async (t) => {
    const { scene, requested } = await setup(t);
    scene.director.task = { kind, name: "wave", direction: "back", sent: false, elapsedSeconds: 8 };
    const name = kind === "moment" ? "wave" : "idle-back";
    scene.step(0.01);
    await turn();
    assert.equal(scene.director.task.kind, "rest");
    assert.equal(
      requested.some((path) => path.startsWith(`${name}/`)),
      false,
    );
  });
}

test("the pre-delivery deadline does not cancel an already delivered held gesture", async (t) => {
  const { scene } = await setup(t);
  const task = { kind: "moment", name: "wave", sent: true, elapsedSeconds: 9, hold: 3 };
  scene.director.task = task;
  Object.assign(scene.world.player, { gesture: "wave", gestureStage: "hold", animation: "wave" });
  scene.step(0.01);
  assert.equal(scene.director.task, task);
  assert.equal(task.hold, 2.99);
});
