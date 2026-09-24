/** Automatic failures stay latched across actions until explicit retry (PRD §13.3, C-SITE-03). */
import assert from "node:assert/strict";
import test from "node:test";
import { automaticScene, moment } from "./automatic-scene-fixture.mjs";

for (const path of ["idle/1.webp", "rotation/1.webp", "rotation/clip.json"]) {
  test(`C-SITE-03 another automatic action cannot retry failed shared ${path}`, async (t) => {
    const { scene, bank, gates, requested, errors, tick } = await automaticScene(t);
    const gate = Promise.withResolvers();
    gates.set(path, gate);
    scene.director.task = moment();
    await tick(20);
    assert.ok(requested.includes(path));
    gate.reject(new Error("shared dependency unavailable"));
    await tick(3);
    assert.equal(errors.length, 1);
    assert.equal(scene.director.task.kind, "rest");
    const failureKey = path.endsWith("clip.json") ? "rotation" : path.replace(".webp", "");
    assert.ok(bank.loads.failed.has(failureKey));
    const before = requested.length;
    for (let i = 0; i < 20; i++) {
      scene.director.task = moment(i % 2 ? "wave" : "bow");
      await tick();
    }
    assert.equal(requested.length, before);
    assert.equal(errors.length, 1);
    assert.equal(bank.animations.candidateOwner, null);
    gates.delete(path);
    await scene.request({ gesture: "bow" });
    await tick();
    assert.equal(bank.loads.failed.has(failureKey), false);
    assert.equal(
      bank.loads.failed.has("wave"),
      false,
      "Recovered dependencies must not poison wave",
    );
    assert.equal(scene.world.player.gesture, "bow");
    scene.director.mode = "auto";
    scene.director.task = moment("wave");
    const retry = scene.director.task;
    for (let i = 0; i < 30 && !retry.sent; i++) await tick();
    assert.equal(retry.sent, true);
    assert.equal(errors.length, 1);
  });
}

test("C-SITE-03 current geometry metadata rejection reports once and waits for explicit retry", async (t) => {
  const { scene, bank, gates, requested, errors, tick } = await automaticScene(t);
  const gate = Promise.withResolvers();
  gates.set("wave/clip.json", gate);
  scene.director.task = moment();
  await tick(10);
  gate.reject(new Error("metadata unavailable"));
  await tick(3);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /wave\/clip.json.*metadata unavailable/);
  assert.equal(scene.director.task.kind, "rest");
  assert.ok(bank.loads.failed.has("wave"));
  assert.equal(
    requested.some((path) => path.startsWith("wave/") && path.endsWith(".webp")),
    false,
  );
  const before = requested.length;
  for (let i = 0; i < 20; i++) {
    scene.director.task = moment();
    await tick();
  }
  assert.equal(requested.length, before);
  assert.equal(errors.length, 1);
  gates.delete("wave/clip.json");
  await scene.request({ gesture: "wave" });
  assert.equal(bank.loads.failed.has("wave"), false);
  assert.equal(scene.pressed.gesture, "wave");
});
