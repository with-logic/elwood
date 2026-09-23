/** Render cadence must not multiply sprite-loading consumers, errors or retries (PRD §13). */
import assert from "node:assert/strict";
import test from "node:test";
import { SpriteBank } from "../sprite-bank.mjs";

const frame = { x: 0, y: 0, w: 1, h: 1, anchor: { x: 0, y: 0 }, socket: { x: 0, y: 0 } };
const clip = { fps: 24, pages: [{ file: "0.webp" }, { file: "1.webp" }], frames: [{ ...frame, page: 0 }, { ...frame, page: 1 }] };
const settle = () => new Promise((resolve) => setImmediate(resolve));
function fixture(t) {
  const original = { fetch: globalThis.fetch, Image: globalThis.Image };
  t.after(() => Object.assign(globalThis, original));
  const errors = [];
  const bank = new SpriteBank((error) => errors.push(error));
  globalThis.fetch = async () => new Response(JSON.stringify(clip));
  globalThis.Image = class { async decode() {} };
  return { bank, errors };
}
function paints(bank, index = 0, name = "wave") {
  for (let i = 0; i < 1000; i++) bank.frame(name, index);
}

test("stalled metadata and entry sheet each retain one frame-driven consumer", async (t) => {
  const { bank, errors } = fixture(t);
  const metadata = Promise.withResolvers();
  const sheet = Promise.withResolvers();
  globalThis.fetch = () => metadata.promise;
  globalThis.Image = class { decode() { return sheet.promise; } };
  let metadataConsumers = 0;
  let pageConsumers = 0;
  const load = bank.load.bind(bank);
  const loadPage = bank.loadPage.bind(bank);
  bank.load = (...args) => { metadataConsumers++; return load(...args); };
  bank.loadPage = (...args) => { pageConsumers++; return loadPage(...args); };
  paints(bank);
  await settle();
  assert.equal(metadataConsumers, 1);
  metadata.resolve(new Response(JSON.stringify(clip)));
  await settle();
  paints(bank);
  await settle();
  assert.equal(pageConsumers, 1);
  sheet.resolve();
  await settle();
  assert.ok(bank.frame("wave", 0));
  assert.deepEqual(errors, []);
});

test("metadata failure reports once, stops paint retries, and explicit preparation recovers", async (t) => {
  const { bank, errors } = fixture(t);
  let requests = 0;
  let failed = true;
  globalThis.fetch = async () => {
    requests++;
    return failed ? new Response("", { status: 503 }) : new Response(JSON.stringify(clip));
  };
  paints(bank);
  await settle();
  assert.equal(errors.length, 1);
  paints(bank);
  await settle();
  assert.equal(requests, 1);
  await assert.rejects(bank.prepare("wave"));
  paints(bank);
  await settle();
  assert.equal(requests, 2, "failed explicit retry must not start automatic retries");
  failed = false;
  await bank.prepare("wave");
  assert.ok(bank.frame("wave", 0));
  assert.equal(requests, 3);
  assert.equal(errors.length, 1);
});

for (const index of [0, 1]) {
  test(`failed ${index ? "lookahead" : "entry"} page stays stopped until explicit retry`, async (t) => {
    const { bank, errors } = fixture(t);
    bank.clips.set("wave", clip);
    if (index) bank.pages.set("wave/0", {});
    let attempts = 0;
    let failed = true;
    globalThis.Image = class {
      async decode() {
        if (new URL(this.src).pathname.endsWith(`/${index}.webp`)) {
          attempts++;
          if (failed) throw new Error("bad sheet");
        }
      }
    };
    paints(bank);
    await settle();
    assert.equal(attempts, 1);
    assert.equal(errors.length, 1);
    paints(bank, index);
    await settle();
    assert.equal(attempts, 1);
    failed = false;
    await bank.prepare("wave");
    paints(bank, index);
    await settle();
    assert.ok(bank.frame("wave", index));
    assert.equal(attempts, 2);
    assert.equal(errors.length, 1);
  });
}

test("explicit preparation resets only the requested animation's failed assets", async (t) => {
  const { bank, errors } = fixture(t);
  let requests = 0;
  globalThis.fetch = async () => { requests++; return new Response("", { status: 503 }); };
  paints(bank, 0, "wave");
  paints(bank, 0, "bow");
  await settle();
  await assert.rejects(bank.prepare("wave"));
  paints(bank, 0, "bow");
  await settle();
  assert.equal(requests, 3);
  assert.equal(errors.length, 2);
});


test("automatic readiness checks share loading and stop after failure", async (t) => {
  const { bank, errors } = fixture(t);
  let requests = 0;
  globalThis.fetch = async () => { requests++; return new Response("", { status: 503 }); };
  for (let i = 0; i < 1000; i++) assert.equal(bank.ensureEntryPage("wave"), false);
  await settle();
  assert.equal(requests, 1);
  assert.equal(errors.length, 1);
  for (let i = 0; i < 1000; i++) assert.equal(bank.ensureEntryPage("wave"), false);
  await settle();
  assert.equal(requests, 1);
  globalThis.fetch = async () => new Response(JSON.stringify(clip));
  await bank.prepare("wave");
  assert.equal(bank.ensureEntryPage("wave"), true);
});

test("cached metadata entry decoding fails once across automatic readiness ticks and explicit retry recovers", async (t) => {
  const { bank, errors } = fixture(t);
  bank.clips.set("wave", clip);
  const decoding = Promise.withResolvers();
  let attempts = 0;
  globalThis.Image = class { decode() { attempts++; return attempts === 1 ? decoding.promise : Promise.resolve(); } };
  for (let i = 0; i < 1000; i++) assert.equal(bank.ensureEntryPage("wave"), false);
  await settle();
  assert.equal(attempts, 1);
  decoding.reject(new Error("bad entry sheet"));
  await settle();
  for (let batch = 0; batch < 3; batch++) {
    for (let i = 0; i < 1000; i++) assert.equal(bank.ensureEntryPage("wave"), false);
    await settle();
  }
  assert.equal(attempts, 1);
  assert.equal(errors.length, 1);
  await bank.prepare("wave");
  assert.equal(attempts, 2);
  assert.equal(errors.length, 1);
  assert.equal(bank.ensureEntryPage("wave"), true);
});
