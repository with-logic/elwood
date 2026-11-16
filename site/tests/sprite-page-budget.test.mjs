/** The decoded cache is bounded by pixel memory, not page count (PRD §13, C-SITE-06). */
import assert from "node:assert/strict";
import test from "node:test";
import { DECODED_SHEET_BYTES, decodedClipBytes, limitsFor, spriteLimits } from "../sprite-limits.mjs";
import { SpritePages } from "../sprite-pages.mjs";

const image = (width, height) => ({ width, height, closed: 0, close() { this.closed++; } });
function pagesHolding(t, sheets) {
  const original = spriteLimits.cacheLimitBytes;
  t.after(() => { spriteLimits.cacheLimitBytes = original; });
  spriteLimits.cacheLimitBytes = sheets * DECODED_SHEET_BYTES;
  return new SpritePages();
}

for (const [deviceMemory, sheets] of [[undefined, 12], [8, 12], [4.1, 12], [4, 6], [2, 6], [0.5, 6]]) {
  test(`C-SITE-06 a device reporting ${deviceMemory ?? "no"} GB caches ${sheets} full sheets`, () => {
    assert.equal(limitsFor({ deviceMemory }).cacheLimitBytes, sheets * DECODED_SHEET_BYTES);
  });
}

test("C-SITE-06 a browser without device hints gets the full cache", () => {
  assert.equal(limitsFor().cacheLimitBytes, 12 * DECODED_SHEET_BYTES);
});

test("C-SITE-06 a clip's decoded size comes from its page metadata, charging unknown pages a full sheet", () => {
  const clip = { pages: [{ width: 1000, height: 500 }, { width: 10, height: 10 }, { file: "unknown.webp" }, { width: 0, height: 9 }] };
  assert.equal(decodedClipBytes(clip), 1000 * 500 * 4 + 400 + 2 * DECODED_SHEET_BYTES);
});

test("C-SITE-06 single-frame pages do not evict working sheets", (t) => {
  const pages = pagesHolding(t, 4);
  const sheets = [0, 1, 2].map(() => image(2048, 2048));
  sheets.forEach((sheet, index) => pages.store(`walk/${index}`, sheet));
  // Thirty standing poses weigh less than one sheet; a count bound would have dropped every walk.
  const poses = Array.from({ length: 30 }, () => image(184, 386));
  poses.forEach((pose, index) => pages.store(`stance/${index}`, pose));
  assert.equal(pages.cached.size, 33);
  assert.deepEqual([...sheets, ...poses].map((page) => page.closed), Array(33).fill(0));
});

test("C-SITE-06 eviction frees the least recently used sheets until the budget fits", (t) => {
  const pages = pagesHolding(t, 4);
  const sheets = Array.from({ length: 5 }, () => image(2048, 2048));
  sheets.slice(0, 4).forEach((sheet, index) => pages.store(`clip/${index}`, sheet));
  assert.equal(pages.acquirePage("clip/0"), sheets[0], "a lookup marks the sheet as used");
  pages.store("clip/4", sheets[4]);
  assert.deepEqual([...pages.cached.keys()], ["clip/2", "clip/3", "clip/0", "clip/4"]);
  assert.deepEqual(sheets.map((sheet) => sheet.closed), [0, 1, 0, 0, 0]);
  // One oversized arrival displaces as many older sheets as it weighs.
  const wide = image(4096, 4096);
  pages.store("wide/0", wide);
  assert.deepEqual([...pages.cached.keys()], ["wide/0"]);
  assert.deepEqual(sheets.map((sheet) => sheet.closed), [1, 1, 1, 1, 1]);
});

test("C-SITE-06 the newest page stays cached even when it alone exceeds the budget", (t) => {
  const pages = pagesHolding(t, 1);
  const huge = image(8192, 8192);
  pages.store("huge/0", huge);
  assert.equal(pages.acquirePage("huge/0"), huge);
  assert.equal(huge.closed, 0);
});

test("C-SITE-06 a page without dimensions is charged as one full sheet", (t) => {
  const pages = pagesHolding(t, 2);
  const unknown = Array.from({ length: 3 }, () => ({ closed: 0, close() { this.closed++; } }));
  unknown.forEach((page, index) => pages.store(`clip/${index}`, page));
  assert.equal(pages.cached.size, 2);
  assert.deepEqual(unknown.map((page) => page.closed), [1, 0, 0]);
});
