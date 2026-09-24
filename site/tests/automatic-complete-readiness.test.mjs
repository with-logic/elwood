/** Automatic delivery waits for complete task-owned animation pages (PRD §13.3, C-SITE-03). */
import assert from "node:assert/strict";
import test from "node:test";
import { automaticScene, moment } from "./automatic-scene-fixture.mjs";

for (const [path, task, name] of [
  ["wave/5.webp", moment(), "wave"],
  ["rotation/1.webp", moment(), "wave"],
  ["idle-back/1.webp", { kind: "face", direction: "back", sent: false, elapsedSeconds: 0 }, "idle-back"],
]) {
  test(`C-SITE-03 automatic ${name} waits for ${path} and resets its delivery clock`, async (t) => {
    const { scene, bank, gates, requested, tick } = await automaticScene(t);
    const gate = Promise.withResolvers();
    gates.set(path, gate);
    scene.director.task = { ...task };
    const current = scene.director.task;
    await tick(40, 0.05);
    assert.equal(current.sent, false, "Partial preparation must not deliver the task");
    assert.ok(requested.includes(path));
    assert.equal(scene.world.player.gesture, null);
    gate.resolve();
    for (let i = 0; i < 30 && !current.sent; i++) await tick();
    assert.equal(current.sent, true);
    assert.equal(current.elapsedSeconds, 0);
    assert.equal(bank.animations.activeOwner.name, name);
    for (const clipName of ["idle", "rotation", name])
      for (const [index] of bank.clips.get(clipName).frames.entries())
        assert.ok(bank.frame(clipName, index), `${clipName} frame ${index} is retained`);
  });
}

for (const shared of [false, true]) {
  test(`C-SITE-03 obsolete geometry probes release only their metadata consumer (shared=${shared})`, async (t) => {
    const { scene, bank, gates, requested, aborted, errors, tick } = await automaticScene(t);
    const gate = Promise.withResolvers();
    gates.set("wave/clip.json", gate);
    scene.director.task = moment();
    await tick(10);
    const survivor = shared ? bank.load("wave") : null;
    survivor?.catch(() => {}); // Keep a premature rejection observable at the awaited assertion.
    const obsolete = scene.automaticPreparation.preparationOwner;
    assert.equal(requested.filter(path => path === "wave/clip.json").length, 1);
    scene.director.task = moment("bow");
    assert.equal(obsolete.controller.signal.aborted, true);
    assert.deepEqual(aborted, shared ? [] : ["wave/clip.json"]);
    if (shared) assert.equal(bank.loads.tasks.get("wave").consumers.size, 1);
    gate.resolve();
    if (shared) assert.equal((await survivor).name, "wave");
    await tick(30);
    assert.equal(scene.world.player.gesture, "bow");
    assert.deepEqual(errors, []);
  });
}

test("C-SITE-03 manual takeover replaces pending automatic pages without stale delivery", async (t) => {
  const { scene, bank, gates, errors, tick } = await automaticScene(t);
  const gate = Promise.withResolvers();
  gates.set("wave/5.webp", gate);
  scene.director.task = moment();
  await tick(20);
  const obsolete = bank.animations.candidateOwner;
  assert.equal(obsolete.name, "wave");
  await scene.request({ gesture: "bow" });
  const manual = bank.animations.deliveredOwner;
  assert.equal(manual.name, "bow");
  assert.equal(obsolete.controller.signal.aborted, true);
  gate.resolve();
  await tick();
  assert.equal(bank.animations.activeOwner, manual);
  assert.equal(scene.world.player.gesture, "bow");
  assert.deepEqual(errors, []);
});

test("C-SITE-03 failures report once and wait for explicit retry", async (t) => {
  const { scene, gates, requested, errors, tick } = await automaticScene(t);
  const gate = Promise.withResolvers(); gates.set("wave/5.webp", gate);
  scene.director.task = moment();
  await tick(20);
  gate.reject(new Error("automatic sheet failed"));
  await tick(3);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /wave\/5.webp.*automatic sheet failed/);
  const before = requested.length;
  for (let i = 0; i < 30; i++) { scene.director.task = moment(); await tick(); }
  assert.equal(requested.length, before);
  assert.equal(errors.length, 1);
  gates.delete("wave/5.webp");
  await scene.request({ gesture: "wave" });
  assert.equal(scene.pressed.gesture, "wave");
});

for (const boundary of ["reset", "reflow", "dispose"]) {
  test(`C-SITE-03 ${boundary} invalidates pending automatic delivery`, async (t) => {
    const { scene, bank, gates, aborted, errors, tick } = await automaticScene(t);
    gates.set("wave/5.webp", Promise.withResolvers());
    scene.director.task = moment();
    await tick(20);
    if (boundary === "dispose") scene.dispose();
    else scene.configure({ ...scene.config, width: scene.config.width + 100 }, boundary === "reset");
    assert.notEqual(scene.director.task?.kind, "moment");
    assert.equal(bank.animations.candidateOwner, null);
    assert.ok(aborted.includes("wave/5.webp"));
    assert.deepEqual(errors, []);
  });
}

test("C-SITE-03 a rejected geometry probe never requests animation pages", async (t) => {
  const { scene, bank, requested, tick } = await automaticScene(t);
  scene.config.width = 100;
  scene.director.task = moment();
  await tick(10);
  assert.ok(requested.includes("wave/clip.json"));
  assert.equal(requested.some(path => path.startsWith("wave/") && path.endsWith(".webp")), false);
  assert.equal(scene.automaticPreparation.preparationOwner, null);
  assert.equal(bank.animations.candidateOwner, null);
});

test("C-SITE-03 the pre-delivery deadline cancels preparation without an asset error", async (t) => {
  const { scene, bank, gates, aborted, errors, tick } = await automaticScene(t);
  gates.set("wave/5.webp", Promise.withResolvers());
  scene.director.task = moment();
  const task = scene.director.task;
  await tick(20);
  scene.step(8);
  assert.equal(task.sent, false);
  assert.equal(scene.director.task.kind, "rest");
  assert.equal(bank.animations.candidateOwner, null);
  assert.ok(aborted.includes("wave/5.webp"));
  assert.deepEqual(errors, []);
});
