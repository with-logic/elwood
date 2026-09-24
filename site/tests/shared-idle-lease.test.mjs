/** Common idle sheets survive complete-animation churn (PRD §13, C-SITE-02). */
import assert from "node:assert/strict";
import test from "node:test";
import { fixture, waitFor } from "./animation-fixture.mjs";

async function complete(bank, name) {
  await bank.prepareAnimation(name);
  bank.publishAnimation(name);
  bank.activateAnimation("rotation", name);
  bank.activateAnimation(name);
}
async function evict(bank) {
  for (let i = 0; i < 6; i++) await bank.loadPage("wave", i);
  assert.equal(bank.pages.size, 4);
}

test("C-SITE-02 idle sheets survive playback trim and cache eviction with immediate keyed frames", async (t) => {
  const { bank, images, requested } = fixture(t);
  await complete(bank, "wave");
  const idle = images.filter((image) => image.path.startsWith("idle/"));
  bank.activateAnimation("rotation");
  bank.retainPoses(bank.frame("rotation", 0));
  assert.deepEqual([...bank.animations.activeOwner.clips.keys()], ["rotation"]);
  await evict(bank);
  assert.equal(bank.pages.has("idle/0"), false);
  const before = requested.length;
  assert.equal(bank.frame("idle", 0)?.page, idle[0]);
  assert.equal(bank.frame("idle", 1)?.page, idle[1]);
  assert.equal(requested.length, before);
  assert.deepEqual(
    idle.map((image) => image.closed),
    [0, 0],
  );
  for (const name of ["bow", "wave", "bow"]) {
    await complete(bank, name);
    bank.activateAnimation("rotation");
    bank.retainPoses(bank.frame("rotation", 0));
    await evict(bank);
  }
  assert.equal(images.filter((image) => image.path.startsWith("idle/")).length, 2);
  assert.equal(requested.filter((path) => /^idle\/\d.webp$/.test(path)).length, 2);
  bank.animations.dispose();
  bank.retainPoses();
  assert.deepEqual(
    idle.map((image) => image.closed),
    [1, 1],
  );
  assert.ok(
    images.every((image) => image.closed === ([...bank.pages.values()].includes(image) ? 0 : 1)),
  );
  bank.dispose();
  bank.dispose();
  assert.ok(images.every((image) => image.closed === 1));
});

for (const outcome of ["failure", "cancel", "dispose"]) {
  test(`C-SITE-02 ${outcome} before complete preparation never retains partial idle sheets`, async (t) => {
    const { bank, images, gates, requested } = fixture(t);
    const gate = Promise.withResolvers();
    gates.set("wave/5.webp", gate);
    const pending = bank.prepareAnimation("wave");
    await waitFor(requested, "wave/5.webp");
    const idle = images.filter((image) => image.path.startsWith("idle/"));
    assert.equal(idle.length, 2);
    if (outcome === "failure") {
      gate.reject(new Error("last sheet unavailable"));
      await assert.rejects(pending, /last sheet unavailable/);
    } else {
      if (outcome === "dispose") bank.dispose();
      else bank.cancelPreparation();
      assert.equal(await pending, null);
    }
    gates.delete("wave/5.webp");
    if (outcome !== "dispose") await evict(bank);
    assert.deepEqual(
      idle.map((image) => image.closed),
      [1, 1],
    );
  });
}

test("C-SITE-02 larger idle manifests use ordinary ownership instead of a larger shared lease", async (t) => {
  const { bank, images } = fixture(t);
  const fetchAsset = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const response = await fetchAsset(url, options);
    if (!new URL(url).pathname.endsWith("/idle/clip.json")) return response;
    const clip = await response.json();
    clip.pages.push({ file: "2.webp" });
    clip.frames.push({ ...clip.frames[0], page: 2 });
    return Response.json(clip);
  };
  await complete(bank, "wave");
  const idle = images.filter((image) => image.path.startsWith("idle/"));
  assert.equal(idle.length, 3);
  bank.activateAnimation("rotation");
  await evict(bank);
  assert.ok(idle.every((image) => image.closed === 1));
});
