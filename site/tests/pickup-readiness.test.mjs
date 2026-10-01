/** Complete pickup preparation through real scene/World/bank boundaries (C-SITE-04). */
import assert from "node:assert/strict";
import test from "node:test";
import { automaticScene, turn } from "./automatic-scene-fixture.mjs";
import { waitFor } from "./animation-fixture.mjs";

async function until(predicate) {
  for (let i = 0; i < 200 && !predicate(); i++) await turn();
  assert.ok(predicate(), "Expected asynchronous pickup progress");
}
async function setup(t, dedicated = true) {
  const assets = await automaticScene(t, name => ["pickup-wriggle", "zero-gravity"].includes(name) ? 6 : 2);
  const { scene } = assets;
  for (const name of ["pickup-fall", "hero-land", "zero-gravity", ...(dedicated ? ["pickup-wriggle"] : [])])
    scene.world.clips[name] = { frames: 6, fps: 24 };
  await scene.bank.prepareAnimation("idle");
  scene.bank.publishAnimation("idle");
  scene.bank.activateAnimation("idle");
  scene.lastPose = scene.pose();
  return assets;
}
const begin = (scene) => scene.beginDrag({ x: 300, y: 400 });

for (const dedicated of [true, false]) {
  test(`C-SITE-04 ${dedicated ? "wriggle" : "fallback"} waits for its last page without delaying movement`, async t => {
    const { scene, gates, requested, aborted, errors } = await setup(t, dedicated);
    const name = dedicated ? "pickup-wriggle" : "zero-gravity", gate = Promise.withResolvers();
    gates.set(`${name}/5.webp`, gate);
    const prior = scene.lastPose;
    assert.equal(begin(scene), true);
    const version = scene.requestVersion;
    await waitFor(requested, `${name}/5.webp`);
    for (let i = 0; i < 100; i++) scene.moveDrag({ x: 300 + i, y: 300 });
    scene.nudgeDrag(12, -12);
    assert.equal(scene.requestVersion, version);
    assert.equal(scene.world.player.mode, "drag");
    assert.equal(scene.world.player.animation, "idle");
    assert.notEqual(scene.drag.point.x, 300);
    scene.step(1 / 24);
    assert.notEqual(scene.pose().frame, prior.frame);
    assert.equal(prior.page.closed, 0);
    assert.deepEqual(aborted, []);
    gate.resolve();
    await until(() => scene.world.player.animation === name);
    assert.equal(scene.world.player.animationTime, 0);
    assert.equal(scene.bank.animations.activeOwner.name, name);
    for (let page = 0; page < 6; page++) assert.ok(scene.bank.frame(name, page));
    assert.deepEqual(errors, []);
  });
}
for (const end of ["drop", "pause", "reset", "reflow", "dispose"]) {
  test(`C-SITE-04 ${end} cancels pending pickup and rejects late delivery`, async t => {
    const { scene, gates, requested, aborted, errors, images } = await setup(t);
    const gate = Promise.withResolvers();
    gates.set("pickup-wriggle/5.webp", gate);
    begin(scene);
    await waitFor(requested, "pickup-wriggle/5.webp");
    if (end === "drop") scene.endDrag();
    else if (end === "pause") scene.pause("user", true);
    else if (end === "reset") scene.home();
    else if (end === "reflow") scene.configure({ ...scene.config, width: 800 });
    else scene.dispose();
    await turn();
    assert.ok(aborted.includes("pickup-wriggle/5.webp"));
    gate.resolve();
    await turn();
    assert.notEqual(scene.world.player.animation, "pickup-wriggle");
    assert.equal(scene.bank.animations.candidateOwner, null);
    assert.deepEqual(errors, []);
    scene.dispose();
    assert.ok(images.every(image => image.closed === 1));
  });
}
test("C-SITE-04 pickup failure reports once; a new drag retries", async t => {
  const { scene, gates, requested, errors } = await setup(t), gate = Promise.withResolvers();
  gates.set("pickup-wriggle/5.webp", gate);
  begin(scene);
  await waitFor(requested, "pickup-wriggle/5.webp");
  gate.reject(new Error("missing pickup page"));
  await until(() => errors.length === 1);
  const count = requested.length;
  for (let i = 0; i < 100; i++) { scene.moveDrag({ x: 300, y: 300 }); scene.pose(); }
  await turn();
  assert.equal(requested.length, count);
  assert.equal(errors.length, 1);
  scene.endDrag();
  gates.delete("pickup-wriggle/5.webp");
  begin(scene);
  await until(() => scene.world.player.animation === "pickup-wriggle");
  assert.equal(scene.world.player.animationTime, 0);
});
test("C-SITE-04 drop after preparation resolves cannot start pickup", async t => {
  const { scene } = await setup(t);
  begin(scene);
  await until(() => scene.world.player.animation === "pickup-wriggle");
  scene.endDrag();
  const prepare = scene.bank.prepareAnimation.bind(scene.bank);
  scene.bank.prepareAnimation = (...args) => prepare(...args).then(clip => {
    scene.endDrag();
    return clip;
  });
  begin(scene);
  await until(() => !scene.dragging);
  await turn();
  assert.equal(scene.world.player.mode, "air");
  assert.notEqual(scene.world.player.animation, "pickup-wriggle");
});
test("C-SITE-04 pickup activation retains every page through pause and supports a warm new drag", async t => {
  const { scene } = await setup(t);
  begin(scene);
  await until(() => scene.world.player.animation === "pickup-wriggle");
  const owner = scene.bank.animations.activeOwner;
  scene.endDrag();
  begin(scene);
  await until(() => scene.world.player.animation === "pickup-wriggle");
  assert.equal(scene.bank.animations.activeOwner, owner);
  scene.pose();
  scene.pause("user", true);
  for (let page = 0; page < 6; page++) assert.equal(scene.bank.frame("pickup-wriggle", page).page.closed, 0);
});
test("C-SITE-04 an obsolete pickup completion cannot consume a newer candidate", async t => {
  const { scene } = await setup(t), prepare = scene.bank.prepareAnimation.bind(scene.bank);
  let replacement;
  scene.bank.prepareAnimation = (...args) => prepare(...args).then(clip => {
    replacement = prepare("bow");
    return clip;
  });
  begin(scene);
  await until(() => !!replacement);
  await replacement;
  assert.equal(scene.world.player.animation, "idle");
  assert.equal(scene.bank.animations.candidateOwner.name, "bow");
});
test("C-SITE-04 an error settled after drop stays silent", async t => {
  const { scene, gates, requested, errors } = await setup(t), gate = Promise.withResolvers();
  gates.set("pickup-wriggle/5.webp", gate);
  const prepare = scene.bank.prepareAnimation.bind(scene.bank);
  scene.bank.prepareAnimation = (...args) => prepare(...args).catch(error => {
    scene.endDrag();
    throw error;
  });
  begin(scene);
  await waitFor(requested, "pickup-wriggle/5.webp");
  gate.reject(new Error("obsolete pickup failure"));
  await until(() => !scene.dragging);
  await turn();
  assert.deepEqual(errors, []);
});
