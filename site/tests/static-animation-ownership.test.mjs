/** Retained one-frame poses release dependency sheets without losing keyed rendering (PRD §13). */
import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "./animation-fixture.mjs";

function staticFixture(t) {
  const result = fixture(t), fetchAsset = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const response = await fetchAsset(url, options);
    if (!new URL(url).pathname.endsWith("clip.json")) return response;
    const clip = await response.json(), count = clip.name === "idle-back" ? 1 : 6;
    clip.pages = Array.from({ length: count }, (_, i) => ({ file: `${i}.webp` }));
    clip.frames = Array.from({ length: count }, (_, i) => ({ ...clip.frames[0], page: i }));
    return Response.json(clip);
  };
  return result;
}

test("a painted static facing releases dependency leases but survives cache churn and transition", async (t) => {
  const { bank, images, requested } = staticFixture(t);
  await bank.prepareAnimation("idle-back");
  bank.publishAnimation("idle-back");
  bank.activateAnimation("rotation", "idle-back");
  const outgoing = bank.frame("rotation", 0);
  bank.retainPoses(outgoing);
  assert.equal(bank.animations.activeOwner.clips.size, 3, "opening turn still needs all sheets");
  bank.activateAnimation("idle-back");
  const current = bank.frame("idle-back", 0);
  assert.equal(bank.animations.activeOwner.clips.size, 3, "activation alone cannot release unpainted resources");
  bank.retainPoses(current, outgoing);
  assert.deepEqual([...bank.animations.activeOwner.clips.keys()], ["idle-back"]);
  for (const image of images) {
    const retained = image === current.page || image === outgoing.page || [...bank.pages.values()].includes(image);
    assert.equal(image.closed, retained ? 0 : 1, image.path);
  }
  for (let i = 0; i < 6; i++) await bank.loadPage("wave", i);
  assert.equal(bank.pages.has("idle-back/0"), false);
  const before = requested.length;
  assert.equal(bank.frame("idle-back", 0).page, current.page);
  assert.equal(requested.length, before, "next paint borrows the retained static page without a new load");
  assert.equal(current.page.closed, 0);
  assert.equal(outgoing.page.closed, 0);
  bank.activateAnimation("wave");
  assert.equal(bank.animations.activeOwner, null);
  bank.retainPoses(bank.frame("wave", 5), current);
  assert.equal(current.page.closed, 0, "static pose remains valid as the outgoing blend");
  assert.equal(outgoing.page.closed, 1);
  bank.retainPoses(bank.frame("wave", 5));
  assert.equal(current.page.closed, 1, "completed outgoing blend releases the last static owner");
});

test("static completion preserves a replacement candidate's shared dependency leases", async (t) => {
  const { bank } = staticFixture(t);
  await bank.prepareAnimation("idle-back");
  bank.publishAnimation("idle-back");
  bank.activateAnimation("idle-back");
  const current = bank.frame("idle-back", 0);
  await bank.prepareAnimation("wave");
  const dependency = bank.animations.candidateOwner.pages.get("rotation/0");
  bank.retainPoses(current);
  assert.deepEqual([...bank.animations.activeOwner.clips.keys()], ["idle-back"]);
  assert.equal(bank.animations.candidateOwner.name, "wave");
  assert.equal(dependency.closed, 0);
  bank.cancelPreparation();
  assert.equal(dependency.closed, 1);
  assert.equal(bank.frame("idle-back", 0).page, current.page);
});
