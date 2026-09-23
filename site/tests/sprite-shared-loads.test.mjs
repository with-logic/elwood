/** Shared asset leases release cancellation without losing another owner (PRD §13). */
import assert from "node:assert/strict";
import test from "node:test";
import { SpriteBank } from "../sprite-bank.mjs";

const turn = () => new Promise((resolve) => setImmediate(resolve));
const clip = { fps: 24, pages: Array.from({ length: 6 }, (_, index) => ({ file: `${index}.webp` })),
  frames: Array.from({ length: 6 }, (_, page) => ({ page, x: 0, y: 0, w: 1, h: 1, anchor: { x: 0, y: 0 }, socket: { x: 0, y: 0 } })) };
function fixture(t) {
  const original = { fetch: globalThis.fetch, Image: globalThis.Image };
  const errors = [], images = [], requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ path: new URL(url).pathname, signal: options?.signal });
    return String(url).includes("clip.json") ? Response.json(clip) : new Response("sheet");
  };
  globalThis.Image = class { closed = 0; async decode() { images.push(this); } close() { this.closed++; } };
  const bank = new SpriteBank((error) => errors.push(error));
  t.after(() => { bank.dispose(); Object.assign(globalThis, original); });
  return { bank, errors, images, requests };
}

for (const stage of ["metadata", "page"]) test(`cancelled ${stage} subscriber leaves automatic failure reporting alive`, async (t) => {
  const { bank, errors } = fixture(t);
  if (stage === "page") bank.clips.set("wave", clip);
  const gate = Promise.withResolvers();
  let calls = 0;
  globalThis.fetch = () => { calls++; return gate.promise; };
  bank.frame("wave", 0);
  await turn();
  const controller = new AbortController();
  let cancelled = false;
  const explicit = bank.prepare("wave", { signal: controller.signal }).catch((error) => { cancelled = error.name === "AbortError"; });
  await turn();
  controller.abort();
  await turn();
  const promptCancellation = cancelled;
  gate.reject(new Error("automatic asset failed"));
  await explicit;
  await turn();
  assert.equal(promptCancellation, true, "cancellation settles before shared asset failure");
  assert.equal(calls, 1);
  assert.equal(errors.length, 1);
  for (let i = 0; i < 100; i++) bank.frame("wave", 0);
  await turn();
  assert.equal(calls, 1, "automatic failure remains latched");
});

test("one explicit cancellation cannot abort another subscriber's shared fetch or decode", async (t) => {
  const { bank, images } = fixture(t);
  bank.clips.set("wave", clip);
  const gate = Promise.withResolvers();
  let calls = 0, signal;
  globalThis.fetch = (_url, options) => { calls++; signal = options?.signal; return gate.promise; };
  const first = new AbortController(), second = new AbortController();
  const abandoned = bank.prepare("wave", { signal: first.signal }).catch((error) => error);
  const delivered = bank.prepare("wave", { signal: second.signal });
  await turn();
  first.abort();
  assert.equal(signal?.aborted, false);
  gate.resolve(new Response("sheet"));
  await delivered;
  assert.equal((await abandoned).name, "AbortError");
  assert.equal(calls, 1);
  assert.equal(images.length, 1);
  assert.equal(images[0].closed, 0);
  second.abort();
  assert.equal(images[0].closed, 0, "cache still owns the shared page");
});

test("late abandoned decode closes its image without replacing or deleting a successor task", async (t) => {
  const { bank } = fixture(t);
  bank.clips.set("wave", clip);
  const gates = [Promise.withResolvers(), Promise.withResolvers()];
  const images = gates.map(() => ({ closed: 0, close() { this.closed++; } }));
  let calls = 0;
  bank.decoder.decode = () => { const index = calls++; return gates[index].promise.then(() => images[index]); };
  const controller = new AbortController();
  const old = bank.loadPage("wave", 0, { signal: controller.signal }).catch((error) => error);
  await turn();
  controller.abort();
  const successor = bank.loadPage("wave", 0);
  await turn();
  gates[0].resolve();
  await turn();
  const stillPending = bank.pendingPages.has("wave/0");
  gates[1].resolve();
  const page = await successor;
  assert.equal((await old).name, "AbortError");
  assert.equal(calls, 2);
  assert.equal(stillPending, true, "old finally must not delete the newer request");
  assert.equal(page, images[1]);
  assert.equal(bank.pages.get("wave/0"), images[1]);
  assert.equal(images[0].closed, 1);
  assert.equal(images[1].closed, 0);
});

test("signal-owned pages survive cache churn and cancellation respects cache and pose owners", async (t) => {
  const { bank, images } = fixture(t);
  bank.clips.set("wave", clip);
  const first = new AbortController(), second = new AbortController();
  const page = await bank.loadPage("wave", 0, { signal: first.signal });
  await Promise.all(Array.from({ length: 5 }, (_, index) => bank.loadPage("wave", index + 1, { signal: first.signal })));
  assert.ok(images.every((image) => image.closed === 0), "all delivery handoffs are pinned before cache churn");
  assert.equal(await bank.loadPage("wave", 0, { signal: second.signal }), page, "another owner joins the retained page after eviction");
  assert.equal(bank.frame("wave", 0).page, page, "joined page is available to automatic rendering");
  bank.clips.set("other", clip);
  for (let index = 0; index < 4; index++) await bank.loadPage("other", index);
  first.abort();
  assert.equal(page.closed, 0, "another lease still owns the evicted page");
  bank.retainPoses({ page });
  second.abort();
  assert.equal(page.closed, 0, "the current pose survives both leases");
  bank.retainPoses();
  assert.equal(page.closed, 1);
});


test("abandoned metadata cannot publish over a successor or remove its pending entry", async (t) => {
  const { bank } = fixture(t);
  const gates = [Promise.withResolvers(), Promise.withResolvers()];
  let calls = 0;
  globalThis.fetch = () => gates[calls++].promise;
  const controller = new AbortController();
  const old = bank.load("wave", { signal: controller.signal }).catch((error) => error);
  await turn();
  controller.abort();
  const successor = bank.load("wave");
  await turn();
  gates[0].resolve(Response.json({ ...clip, version: "old" }));
  await turn();
  const stillPending = bank.clipPromises.has("wave");
  assert.equal(bank.clips.has("wave"), false, "obsolete metadata is never observable");
  gates[1].resolve(Response.json({ ...clip, version: "current" }));
  const loaded = await successor;
  assert.equal((await old).name, "AbortError");
  assert.equal(calls, 2);
  assert.equal(stillPending, true);
  assert.equal(loaded.version, "current");
  assert.equal(bank.clips.get("wave"), loaded);
});

test("a retained page promoted back into cache outlives its released lease", async (t) => {
  const { bank, images } = fixture(t);
  bank.clips.set("wave", clip);
  const owner = new AbortController();
  const page = await bank.loadPage("wave", 0, { signal: owner.signal });
  for (let index = 1; index < 5; index++) await bank.loadPage("wave", index);
  assert.equal(await bank.loadPage("wave", 0), page);
  owner.abort();
  assert.equal(images.length, 5);
  assert.equal(page.closed, 0);
  assert.equal(bank.frame("wave", 0).page, page);
});
