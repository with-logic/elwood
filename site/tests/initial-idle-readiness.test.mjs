/** Complete idle handoff with real scene, bank and render boundaries (PRD §13.2, C-SITE-02). */
import assert from "node:assert/strict";
import test from "node:test";
import { LandingScene } from "../landing-scene.mjs";
import { fixture, turn, waitFor } from "./animation-fixture.mjs";

function setup(t) {
  const assets = fixture(t);
  const keys = ["document", "matchMedia", "devicePixelRatio", "requestAnimationFrame", "cancelAnimationFrame"];
  const original = Object.fromEntries(keys.map((key) => [key, globalThis[key]]));
  const context = new Proxy({ drawImage(image) { assert.ok(!image.closed); } }, {
    get: (target, key) => target[key] ?? (() => {}),
  });
  const canvas = () => ({ getContext: () => context });
  Object.assign(globalThis, {
    document: { createElement: canvas }, matchMedia: () => ({ matches: false }),
    devicePixelRatio: 1, requestAnimationFrame: () => 1, cancelAnimationFrame() {},
  });
  const fetchAsset = globalThis.fetch;
  globalThis.fetch = (url, options) => new URL(url).pathname.endsWith("manifest.json")
    ? Promise.resolve(Response.json({ clips: { idle: { frames: 2, fps: 24 } }, angles: {},
      rotation_angles: [], walk_transitions: {}, walk_starts: {} }))
    : fetchAsset(url, options);
  let ready = 0, painted = 0;
  const scene = new LandingScene(canvas(), { onReady: () => ready++, onPaint: () => painted++,
    onError: (error) => assets.errors.push(error) });
  scene.bank.dispose();
  scene.bank = assets.bank;
  t.after(() => { scene.dispose(); Object.assign(globalThis, original); });
  return { ...assets, scene, callbacks: () => ({ ready, painted }) };
}

test("C-SITE-02 all idle pages precede handoff and survive cache churn without rotation", async (t) => {
  const { scene, bank, gates, requested, aborted, errors, callbacks } = setup(t);
  const gate = Promise.withResolvers();
  gates.set("idle/1.webp", gate);
  const boot = scene.boot();
  await waitFor(requested, "idle/1.webp");
  assert.equal(scene.ready, false);
  assert.deepEqual(callbacks(), { ready: 0, painted: 0 });
  scene.interact();
  scene.clearInput();
  scene.pause("hidden", true);
  scene.pause("hidden", false);
  await turn();
  assert.deepEqual(aborted, []);
  assert.deepEqual(callbacks(), { ready: 0, painted: 0 });
  gate.resolve();
  await boot;
  assert.equal(scene.ready, true);
  assert.deepEqual(callbacks(), { ready: 1, painted: 1 });
  assert.deepEqual(requested, ["idle/clip.json", "idle/0.webp", "idle/1.webp"]);
  const pages = [bank.frame("idle", 0).page, bank.frame("idle", 1).page];
  for (const name of ["wave", "bow", "walk", "jump", "land"]) await bank.prepare(name);
  for (const index of [0, 1]) {
    const pose = bank.frame("idle", index);
    assert.ok(pose, `Idle frame ${index} remains available after cache eviction`);
    assert.equal(pose.page, pages[index]);
    assert.equal(pages[index].closed, 0);
    scene.world.player.animationTime = index / 24;
    scene.paint(0);
  }
  assert.deepEqual(errors, []);
  bank.activateAnimation("walk");
  assert.equal(pages[0].closed, 1);
  assert.equal(pages[1].closed, 0, "The last painted pose still owns its image");
  scene.dispose();
  assert.ok(pages.every((page) => page.closed === 1));
});

test("C-SITE-02 later idle page failure keeps fallback and explicit boot retry recovers", async (t) => {
  const { scene, bank, gates, requested, errors, callbacks } = setup(t);
  const gate = Promise.withResolvers();
  gates.set("idle/1.webp", gate);
  const boot = scene.boot();
  await waitFor(requested, "idle/1.webp");
  gate.reject(new Error("second idle sheet unavailable"));
  await boot;
  assert.equal(scene.ready, false);
  assert.deepEqual(callbacks(), { ready: 0, painted: 0 });
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /idle\/1.webp.*second idle sheet unavailable/);
  assert.equal(bank.animations.candidateOwner, null);
  gates.delete("idle/1.webp");
  await scene.boot();
  assert.equal(scene.ready, true);
  assert.deepEqual(callbacks(), { ready: 1, painted: 1 });
});

for (const dispose of [false, true]) {
  test(`C-SITE-02 ${dispose ? "teardown" : "cancellation"} prevents late initial handoff`, async (t) => {
    const { scene, bank, gates, requested, errors, callbacks } = setup(t);
    gates.set("idle/1.webp", Promise.withResolvers());
    const boot = scene.boot();
    await waitFor(requested, "idle/1.webp");
    if (dispose) scene.dispose();
    else bank.cancelPreparation();
    await boot;
    assert.equal(scene.ready, false);
    assert.deepEqual(callbacks(), { ready: 0, painted: 0 });
    assert.deepEqual(errors, []);
    assert.equal(bank.animations.candidateOwner, null);
  });
}
