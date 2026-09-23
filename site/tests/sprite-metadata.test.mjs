/** Invalid metadata follows the same bounded automatic failure path (PRD §13). */
import assert from "node:assert/strict";
import test from "node:test";
import { SpriteBank } from "../sprite-bank.mjs";

const frame = { page: 0, x: 0, y: 0, w: 1, h: 1, anchor: { x: 0, y: 0 }, socket: { x: 0, y: 0 } };
const clip = { fps: 24, pages: [{ file: "0.webp" }], frames: [frame] };
const settle = () => new Promise((resolve) => setImmediate(resolve));

for (const malformed of [
  null, {}, { ...clip, frames: [] }, { ...clip, pages: [] },
  { ...clip, frames: [null] }, { ...clip, frames: [{ ...frame, page: 1 }] },
  { ...clip, frames: [{ ...frame, anchor: null }] },
  { ...clip, frames: [{ ...frame, socket: {} }] },
  { ...clip, frames: [{ ...frame, w: 0 }] },
  { ...clip, pages: [{ file: "" }] }, { ...clip, fps: 0 },
]) {
  test(`malformed metadata is rejected before caching: ${JSON.stringify(malformed)}`, async (t) => {
    const original = { fetch: globalThis.fetch, Image: globalThis.Image };
    t.after(() => Object.assign(globalThis, original));
    let calls = 0, failed = true;
    const errors = [];
    globalThis.fetch = async () => { calls++; return Response.json(failed ? malformed : clip); };
    globalThis.Image = class { async decode() {} };
    const bank = new SpriteBank((error) => errors.push(error));
    for (let batch = 0; batch < 3; batch++) {
      for (let i = 0; i < 1000; i++) {
        bank.ensureMetadata("wave");
        assert.equal(bank.ensureEntryPage("wave"), false);
      }
      await settle();
    }
    assert.equal(calls, 1);
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /wave/);
    assert.equal(bank.clips.has("wave"), false);
    failed = false;
    await bank.prepare("wave");
    assert.equal(calls, 2);
    assert.equal(bank.ensureEntryPage("wave"), true);
  });
}
