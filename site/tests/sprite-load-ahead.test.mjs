/** A bank decodes a clip ahead of use without owning, leasing or reporting it (PRD §13.5, C-SITE-06). */
import assert from "node:assert/strict";
import test from "node:test";
import { DECODED_SHEET_BYTES, spriteLimits } from "../sprite-limits.mjs";
import { fixture, turn, waitFor } from "./animation-fixture.mjs";

const settle = async () => { for (let i = 0; i < 20; i++) await turn(); };
const count = (requested, path) => requested.filter((entry) => entry === path).length;
// Fixture pages carry no dimensions, so each is charged as one full sheet.
function cacheHolding(t, sheets) {
  const original = spriteLimits.cacheLimitBytes;
  t.after(() => { spriteLimits.cacheLimitBytes = original; });
  spriteLimits.cacheLimitBytes = sheets * DECODED_SHEET_BYTES;
}

test("C-SITE-06 loading ahead decodes every page of a clip once and later frames need no request", async (t) => {
  const { bank, requested, errors } = fixture(t);
  const [first, second] = await Promise.all([bank.loadAhead("bow"), bank.loadAhead("bow")]);
  assert.equal(first, 2 * DECODED_SHEET_BYTES);
  assert.equal(second, first);
  assert.equal(await bank.loadAhead("bow"), first);
  assert.deepEqual(requested.toSorted(), ["bow/0.webp", "bow/1.webp", "bow/clip.json"]);
  assert.ok(bank.frame("bow", 0));
  assert.ok(bank.frame("bow", 1));
  assert.equal(requested.length, 3);
  assert.deepEqual(errors, []);
});

test("C-SITE-06 pages loaded ahead hold no lease and leave the cache like any other page", async (t) => {
  cacheHolding(t, 4);
  const { bank, images } = fixture(t);
  await bank.loadAhead("bow");
  const ahead = images.filter((image) => image.path.startsWith("bow/"));
  assert.equal(ahead.length, 2);
  for (let i = 0; i < 6; i++) await bank.loadPage("wave", i);
  assert.deepEqual(ahead.map((image) => image.closed), [1, 1]);
});

test("C-SITE-06 a clip that is declined loads only its metadata", async (t) => {
  const { bank, requested } = fixture(t);
  const sizes = [];
  assert.equal(await bank.loadAhead("wave", (bytes) => { sizes.push(bytes); return false; }), 0);
  assert.deepEqual(sizes, [6 * DECODED_SHEET_BYTES]);
  assert.deepEqual(requested, ["wave/clip.json"]);
});

test("C-SITE-06 loading ahead shares its requests with complete preparation", async (t) => {
  const { bank, requested, gates } = fixture(t);
  const gate = Promise.withResolvers();
  gates.set("wave/5.webp", gate);
  const ahead = bank.loadAhead("wave");
  await waitFor(requested, "wave/5.webp");
  const prepared = bank.prepareAnimation("wave");
  await settle();
  gate.resolve();
  assert.ok(await prepared);
  assert.equal(await ahead, 6 * DECODED_SHEET_BYTES);
  for (let page = 0; page < 6; page++) assert.equal(count(requested, `wave/${page}.webp`), 1);
});

for (const stage of ["clip.json", "1.webp"]) {
  test(`C-SITE-06 a failed ${stage} loaded ahead reports nothing and first real use retries it`, async (t) => {
    const { bank, requested, gates, errors } = fixture(t);
    const gate = Promise.withResolvers();
    gates.set(`bow/${stage}`, gate);
    const ahead = bank.loadAhead("bow");
    await waitFor(requested, `bow/${stage}`);
    gate.reject(new Error("unavailable asset"));
    assert.equal(await ahead, 0);
    assert.deepEqual(errors, []);
    assert.equal(bank.hasAnimationFailure("bow"), false, "no failure latch suppresses automatic use");
    gates.delete(`bow/${stage}`);
    // A paint asks for the clip: an ordinary automatic load, free to try again.
    for (let i = 0; i < 20 && !bank.frame("bow", 1); i++) await turn();
    assert.ok(bank.frame("bow", 1));
    assert.equal(count(requested, `bow/${stage}`), 2);
    assert.deepEqual(errors, []);
  });
}

test("C-SITE-06 a failure shared with a paint still reports once and is not retried", async (t) => {
  const { bank, requested, gates, errors } = fixture(t);
  await bank.load("bow");
  const gate = Promise.withResolvers();
  gates.set("bow/0.webp", gate);
  const ahead = bank.loadAhead("bow");
  await waitFor(requested, "bow/0.webp");
  assert.equal(bank.frame("bow", 0), null);
  gate.reject(new Error("unavailable asset"));
  assert.equal(await ahead, 0);
  await settle();
  assert.equal(errors.length, 1);
  for (let i = 0; i < 20; i++) bank.frame("bow", 0);
  await settle();
  assert.equal(count(requested, "bow/0.webp"), 1);
  assert.equal(errors.length, 1);
});

test("C-SITE-06 when the first real use after a failed load ahead also fails, that use reports once", async (t) => {
  const { bank, requested, gates, errors } = fixture(t);
  const ahead = Promise.withResolvers();
  gates.set("bow/1.webp", ahead);
  const loading = bank.loadAhead("bow");
  await waitFor(requested, "bow/1.webp");
  ahead.reject(new Error("unavailable asset"));
  assert.equal(await loading, 0);
  assert.deepEqual(errors, []);
  const used = Promise.withResolvers();
  gates.set("bow/1.webp", used);
  assert.equal(bank.frame("bow", 1), null);
  for (let i = 0; i < 20 && count(requested, "bow/1.webp") < 2; i++) await turn();
  used.reject(new Error("unavailable asset"));
  await settle();
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /bow\/1\.webp/);
  for (let i = 0; i < 20; i++) bank.frame("bow", 1);
  await settle();
  assert.equal(count(requested, "bow/1.webp"), 2, "a reported failure is not retried by later paints");
  assert.equal(errors.length, 1);
});
