/** Bounded preparation and completed clip leases (PRD §13; internal sprite ownership). */
import assert from "node:assert/strict";
import test from "node:test";
import { fixture, turn, waitFor } from "./animation-fixture.mjs";

for (const phase of ["metadata", "pages"]) {
  test(`preparation overlaps ${phase} fetches within a bounded window`, async (t) => {
    const { bank, gates, requested } = fixture(t);
    for (const name of ["idle", "rotation", "wave"]) {
      const count = name === "wave" ? 6 : 2;
      for (const path of phase === "metadata" ? [`${name}/clip.json`] :
        Array.from({ length: count }, (_, i) => `${name}/${i}.webp`))
        gates.set(path, Promise.withResolvers());
    }
    const pending = bank.prepareAnimation("wave");
    try {
      await waitFor(requested, phase === "metadata" ? "idle/clip.json" : "idle/0.webp");
      for (let i = 0; i < 10; i++) await turn();
      const blocked = requested.filter((path) => gates.has(path));
      assert.equal(blocked.length, phase === "metadata" ? 3 : 4);
      if (phase === "pages") {
        gates.get(blocked[0]).resolve();
        for (let i = 0; i < 100 && requested.filter((path) => gates.has(path)).length < 5; i++) await turn();
        assert.equal(requested.filter((path) => gates.has(path)).length, 5);
      }
    } finally {
      bank.cancelPreparation();
      assert.equal(await pending, null);
    }
  });
}

test("opening turn retains the request; completed playback releases it but keeps dependency and pose leases", async (t) => {
  const { bank, images } = fixture(t);
  await bank.prepareAnimation("wave");
  bank.publishAnimation("wave");
  bank.activateAnimation("rotation", "wave");
  const requestPage = bank.frame("wave", 0).page;
  assert.equal(requestPage.closed, 0);
  bank.cancelPreparation();
  assert.equal(requestPage.closed, 0, "consumed opening turn owns the requested clip");
  bank.activateAnimation("wave");
  const outgoing = bank.frame("wave", 0);
  bank.retainPoses(outgoing);
  bank.activateAnimation("rotation", "idle");
  const rotation = bank.frame("rotation", 1);
  bank.retainPoses(rotation, outgoing);
  assert.equal(outgoing.page.closed, 0);
  assert.equal(rotation.page.closed, 0);
  assert.equal(bank.frame("idle", 1).page.closed, 0);
  const released = images.filter((image) => image.path.startsWith("wave/") && image !== outgoing.page);
  assert.ok(released.some((image) => image.closed === 1));
  assert.ok(released.every((image) => image.closed === (bank.pages.has(image.path.replace(".webp", "")) ? 0 : 1)));
  bank.activateAnimation("idle");
  bank.retainPoses(bank.frame("idle", 0));
  assert.equal(outgoing.page.closed, 1);
  assert.equal(rotation.page.closed, bank.pages.has("rotation/1") ? 0 : 1);
});


test("idle after playback or reset releases the requested clip without losing idle sheets", async (t) => {
  const { bank, images } = fixture(t);
  await bank.prepareAnimation("wave");
  bank.publishAnimation("wave");
  bank.activateAnimation("wave");
  const outgoing = bank.frame("wave", 0);
  bank.retainPoses(outgoing);
  bank.activateAnimation("idle");
  const evicted = images.find((image) => image.path === "wave/1.webp");
  assert.equal(evicted.closed, 1);
  assert.equal(outgoing.page.closed, 0);
  for (const index of [0, 1]) assert.equal(bank.frame("idle", index).page.closed, 0);
  bank.retainPoses();
  assert.equal(outgoing.page.closed, bank.pages.has("wave/0") ? 0 : 1);
  await bank.prepareAnimation("wave");
  bank.publishAnimation("wave");
  bank.activateAnimation("wave");
  assert.equal(bank.frame("wave", 1).page.closed, 0, "repeating the released request reloads its missing sheets");
});
