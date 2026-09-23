/** Complete preparation joins live automatic tasks and releases only its leases (PRD §13). */
import assert from "node:assert/strict";
import test from "node:test";
import { SpriteBank } from "../sprite-bank.mjs";

const turn = () => new Promise((resolve) => setImmediate(resolve));
const clip = { fps: 24, pages: [{ file: "0.webp" }], frames: [{ page: 0, x: 0, y: 0, w: 1, h: 1, anchor: { x: 0, y: 0 }, socket: { x: 0, y: 0 } }] };
function fixture(t, stage) {
  const original = { fetch: globalThis.fetch, Image: globalThis.Image };
  const errors = [], decoded = [];
  const gate = Promise.withResolvers();
  const path = stage === "metadata" ? "rotation/clip.json" : "rotation/0.webp";
  let calls = 0;
  globalThis.fetch = async (url) => {
    if (new URL(url).pathname.endsWith(path)) { calls++; await gate.promise; }
    return String(url).includes("clip.json") ? Response.json(clip) : new Response(String(url));
  };
  globalThis.Image = class { closed = 0; async decode() { decoded.push(this); } close() { this.closed++; } };
  const bank = new SpriteBank((error) => errors.push(error));
  t.after(() => { bank.dispose(); Object.assign(globalThis, original); });
  if (stage === "metadata") bank.ensureMetadata("rotation");
  else { bank.clips.set("rotation", clip); bank.frame("rotation", 0); }
  return { bank, errors, decoded, gate, calls: () => calls };
}
async function idlePrepared(bank) {
  for (let i = 0; i < 100 && !bank.animations.candidateOwner?.pages.has("idle/0"); i++) await turn();
  assert.ok(bank.animations.candidateOwner?.pages.has("idle/0"));
}

for (const stage of ["metadata", "page"]) {
  test(`cancelled full preparation restores surviving automatic ${stage} error ownership`, async (t) => {
    const { bank, errors, gate, calls } = fixture(t, stage);
    let cancelled = false;
    const preparing = bank.prepareAnimation("wave").then((result) => { cancelled = result === null; });
    await idlePrepared(bank);
    bank.cancelPreparation();
    await turn();
    const promptCancellation = cancelled;
    gate.reject(new Error("surviving automatic asset failed"));
    await preparing;
    await turn();
    assert.equal(promptCancellation, true);
    assert.equal(calls(), 1);
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /rotation\//);
    assert.equal(errors[0].cause.message, "surviving automatic asset failed");
  });

  test(`full preparation joins automatic ${stage} before delivery and shares its published value`, async (t) => {
    const { bank, errors, decoded, gate, calls } = fixture(t, stage);
    let delivered = false;
    const preparing = bank.prepareAnimation("wave").then((result) => { delivered = true; return result; });
    await idlePrepared(bank);
    assert.equal(delivered, false);
    gate.resolve();
    await preparing;
    await turn();
    bank.publishAnimation("wave");
    assert.equal(calls(), 1, "one metadata fetch or page fetch/decode per shared key");
    assert.equal(decoded.length, 3, "idle, rotation, and wave each decode one sheet");
    assert.equal(bank.clips.get("rotation"), bank.animations.deliveredOwner.clips.get("rotation"));
    assert.equal(bank.pages.get("rotation/0"), bank.frame("rotation", 0).page);
    assert.deepEqual(errors, []);
  });
}
