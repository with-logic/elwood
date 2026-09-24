/** Explicit readiness shares failure authority and releases canceled delivery (PRD §13). */
import assert from "node:assert/strict";
import test from "node:test";
import { fixture as bankFixture } from "./animation-fixture.mjs";
import { LandingScene } from "../landing-scene.mjs";
import { World } from "../world.mjs";

const turn = () => new Promise((resolve) => setImmediate(resolve));
async function waitFor(predicate) {
  for (let i = 0; i < 100 && !predicate(); i++) await turn();
  assert.ok(predicate(), "expected asset work to reach the test boundary");
}
const clip = (name) => ({ name, fps: 24,
  pages: Array.from({ length: name === "wave" ? 6 : 2 }, (_, index) => ({ file: `${index}.webp` })),
  frames: Array.from({ length: name === "wave" ? 6 : 2 }, (_, page) => ({ page, x: 0, y: 0, w: 1, h: 1, anchor: { x: 0, y: 0 }, socket: { x: 0, y: 0 } })),
});
function fixture(t) {
  const { bank, requested: requests, images, errors } = bankFixture(t);
  const scene = Object.create(LandingScene.prototype);
  Object.assign(scene, { bank, ready: true, requestVersion: 0, pressed: {}, pauses: new Set(),
    world: { player: { queuedAction: null } }, director: { interact() {} }, start() {},
    onError(error) { errors.push(error); },
  });
  return { bank, scene, requests, images, errors };
}

for (const first of ["automatic", "explicit"]) for (const stage of ["metadata", "page"]) {
  test(`${first} starts first: shared ${stage} failure reports once and explicit retry recovers`, async (t) => {
    const { bank, errors } = fixture(t);
    const gate = Promise.withResolvers(), fetchAsset = globalThis.fetch;
    const path = stage === "metadata" ? "rotation/clip.json" : "rotation/0.webp";
    let calls = 0;
    globalThis.fetch = (url, options) => {
      if (new URL(url).pathname.endsWith(path)) { calls++; return gate.promise; }
      return fetchAsset(url, options);
    };
    const automatic = () => {
      if (stage === "metadata") bank.ensureMetadata("rotation");
      else { bank.clips.set("rotation", clip("rotation")); bank.frame("rotation", 0); }
    };
    if (first === "automatic") { automatic(); await waitFor(() => calls > 0); }
    const pending = bank.prepareAnimation("wave").catch((error) => errors.push(error));
    await waitFor(() => calls > 0);
    if (first === "explicit") automatic();
    await turn();
    gate.reject(new Error("shared asset failed"));
    await pending;
    await turn();
    assert.equal(calls, 1);
    assert.equal(errors.length, 1);
    assert.equal(bank.loads.failed.has(stage === "metadata" ? "rotation" : "rotation/0"), true);
    globalThis.fetch = fetchAsset;
    await bank.prepareAnimation("wave");
    bank.publishAnimation("wave");
    bank.activateAnimation("wave");
    assert.equal(bank.loads.failed.size, 0);
    assert.equal(bank.frame("rotation", 0).page.closed, 0);
    assert.equal(errors.length, 1);
  });
}

test("cleared delivery releases its sheets while active and outgoing poses remain alive", async (t) => {
  const { bank, scene, images } = fixture(t);
  await scene.request({ gesture: "wave" });
  bank.activateAnimation("wave");
  const current = bank.frame("wave", 0);
  await scene.request({ gesture: "jump" });
  const outgoing = bank.frame("jump", 0);
  bank.retainPoses(current, outgoing);
  scene.clearInput();
  assert.ok(images.filter((image) => image.path.startsWith("jump/") && image !== outgoing.page).every((image) => image.closed === ([...bank.pages.values()].includes(image) ? 0 : 1)));
  assert.equal(current.page.closed, 0);
  assert.equal(outgoing.page.closed, 0);
  bank.retainPoses(current);
  assert.equal(outgoing.page.closed, [...bank.pages.values()].includes(outgoing.page) ? 0 : 1);
  assert.equal(bank.frame("wave", 5).page.closed, 0);
});

test("superseding delivered input invalidates queued recovery before releasing its owner", async (t) => {
  const { bank, scene, images } = fixture(t);
  await scene.request({ gesture: "wave" });
  scene.world.player.queuedAction = { gesture: "wave" };
  const pending = scene.request({ gesture: "jump" });
  assert.equal(scene.pressed.gesture, undefined);
  assert.equal(scene.world.player.queuedAction, null);
  assert.ok(images.filter((image) => image.path.startsWith("wave/")).every((image) => image.closed === ([...bank.pages.values()].includes(image) ? 0 : 1)));
  await pending;
  assert.equal(scene.pressed.gesture, "jump");
  bank.activateAnimation("jump");
  assert.equal(bank.frame("jump", 0).page.closed, 0);
});

for (const [input, name] of [[{ gesture: "wave" }, "wave"], [{ face: "back" }, "idle-back"]]) {
  test(`a consumed ${name} request owns its turn before the next paint`, async (t) => {
    const { bank, scene } = fixture(t);
    scene.world = new World();
    scene.world.canRender = (clipName, index) => !!bank.frame(clipName, index);
    scene.director.update = () => ({});
    await scene.request(input);
    const page = bank.frame(name, 0).page;
    scene.step(1 / 120);
    assert.equal(scene.world.player.turn.target, name);
    scene.clearInput();
    assert.equal(page.closed, 0, "consumed input is active before a paint can retain its pose");
    assert.equal(bank.frame(name, 0).page, page);
  });
}


test("entry-page preparation does not claim failures for other automatic sheets", async (t) => {
  const { bank, errors } = fixture(t);
  bank.clips.set("wave", clip("wave"));
  const automatic = Promise.withResolvers(), fetchAsset = globalThis.fetch;
  globalThis.fetch = (url, options) => new URL(url).pathname.endsWith("wave/1.webp")
    ? automatic.promise : fetchAsset(url, options);
  bank.frame("wave", 1);
  await bank.prepare("wave");
  automatic.reject(new Error("later sheet failed"));
  await turn();
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /wave\/1.webp/);
  assert.equal(errors[0].cause.message, "later sheet failed");
});

for (const state of ["air", "hang", "climb", "landing", "settle"]) {
  test(`ignored gesture during ${state} releases delivered ownership`, async (t) => {
    const { bank, scene, images } = fixture(t);
    scene.world = new World();
    scene.world.canRender = (name, index) => !!bank.frame(name, index);
    scene.director.update = () => ({});
    if (["landing", "settle"].includes(state)) scene.world.player[state] = 1;
    else Object.assign(scene.world.player, { mode: state, y: 200 });
    await scene.request({ gesture: "wave" });
    scene.step(1 / 120);
    assert.equal(scene.world.player.queuedAction, null);
    assert.equal(bank.animations.deliveredOwner, null);
    assert.ok(images.filter((image) => image.path.startsWith("wave/")).every((image) => image.closed === ([...bank.pages.values()].includes(image) ? 0 : 1)));
  });
}

for (const [input, name] of [[{ gesture: "wave" }, "wave"], [{ face: "back" }, "idle-back"]]) {
  test(`queued ${name} preparation survives another gesture's recovery`, async (t) => {
    const { bank, scene } = fixture(t);
    scene.world = new World();
    scene.world.clips.cartwheel = { finish_before_next: true };
    Object.assign(scene.world.player, { gesture: "cartwheel", gestureStage: "enter", animation: "cartwheel" });
    scene.director.update = () => ({});
    await scene.request(input);
    const page = bank.frame(name, 0).page;
    scene.step(1 / 120);
    assert.deepEqual(scene.world.player.queuedAction, input);
    assert.equal(bank.animations.deliveredOwner.name, name);
    assert.equal(page.closed, 0);
  });
}
