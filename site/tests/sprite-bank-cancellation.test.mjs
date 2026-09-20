/** Superseded network work cannot hold later sprite preparations or serialize downloads. */
import { resolveObjectURL } from "node:buffer";
import assert from "node:assert/strict";
import test from "node:test";
import { SpriteBank } from "../sprite-bank.mjs";

const clip = { pages: [{ file: "0.webp" }], frames: [{ page: 0 }] };
function setup(t, decode = async () => {}) {
  const originalFetch = globalThis.fetch;
  const originalImage = globalThis.Image;
  globalThis.fetch = async (url) => new Response(String(url));
  globalThis.Image = class {
    async decode() { await decode(await resolveObjectURL(this.src).text()); }
  };
  t.after(() => { globalThis.fetch = originalFetch; globalThis.Image = originalImage; });
  const bank = new SpriteBank(() => {});
  for (const name of ["idle", "rotation", "ready", "latest"]) bank.clips.set(name, clip);
  return bank;
}

for (const phase of ["sheet", "metadata"]) {
  test(`a stalled superseded ${phase} cannot block the current preparation`, async (t) => {
    const bank = setup(t);
    await bank.prepareAnimation("ready");
    bank.activate("idle");
    if (phase === "sheet") bank.clips.set("old", clip);
    const gate = Promise.withResolvers();
    const entered = Promise.withResolvers();
    let oldSignal;
    globalThis.fetch = async (url, { signal } = {}) => {
      if (String(url).includes("/old/")) {
        oldSignal = signal;
        entered.resolve();
        await gate.promise;
        return new Response(phase === "sheet" ? "old" : JSON.stringify(clip));
      }
      return new Response(String(url));
    };
    const old = bank.prepareAnimation("old");
    await entered.promise;
    const latest = bank.prepareAnimation("latest");
    let releasedByDeadline = false;
    const deadline = setTimeout(() => { releasedByDeadline = true; gate.resolve(); }, 2_000);
    try {
      await latest;
      assert.equal(releasedByDeadline, false, "current work must finish while stale fetch is still held");
      assert.equal(oldSignal.aborted, true);
      assert.equal(bank.prepared.name, "latest");
      assert.equal(bank.animationReady("old"), false);
      assert.equal(bank.activeName, "idle");
      assert.ok(bank.frame("idle", 0));
      assert.ok(bank.frame("rotation", 0));
    } finally {
      clearTimeout(deadline);
      gate.resolve();
      await Promise.all([old, latest]);
    }
  });
}

test("playground-style prepares download together while only one image decodes", async (t) => {
  const downloads = Promise.withResolvers();
  const decodeGate = Promise.withResolvers();
  const decoding = Promise.withResolvers();
  const requested = [];
  let active = 0;
  let peak = 0;
  const bank = setup(t, async () => {
    peak = Math.max(peak, ++active);
    decoding.resolve();
    await decodeGate.promise;
    active--;
  });
  const names = ["idle", "walk-right", "walk-left", "jump"];
  for (const name of names) bank.clips.set(name, clip);
  globalThis.fetch = async (url) => {
    requested.push(String(url));
    await downloads.promise;
    return new Response(String(url));
  };
  const prepared = Promise.all(names.map((name) => bank.prepare(name)));
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(requested.length, 4, "all transfers start before any completes");
    downloads.resolve();
    await decoding.promise;
    assert.equal(active, 1);
    decodeGate.resolve();
    await prepared;
    assert.equal(peak, 1);
    assert.equal(requested.length, 4);
  } finally { downloads.resolve(); decodeGate.resolve(); await prepared; }
});

async function queued(bank, name) {
  for (let tick = 0; tick < 20 && !bank.pendingPages.has(`${name}/0`); tick++)
    await new Promise((resolve) => setImmediate(resolve));
  assert.ok(bank.pendingPages.has(`${name}/0`));
}

test("async-spaced supersession releases candidates and skips their queued decodes", async (t) => {
  const gate = Promise.withResolvers();
  const entered = Promise.withResolvers();
  const decoded = [];
  const bank = setup(t, async (url) => {
    decoded.push(url);
    if (url.includes("/old/")) { entered.resolve(); await gate.promise; }
  });
  for (const name of ["old", "b", "c", "latest"]) bank.clips.set(name, {
    pages: [{ file: "0.webp" }, { file: "1.webp" }], frames: [{ page: 0 }, { page: 1 }],
  });
  await bank.prepareAnimation("ready");
  bank.activate("idle");
  const old = bank.prepareAnimation("old");
  await entered.promise;
  const b = bank.prepareAnimation("b");
  await queued(bank, "b");
  const c = bank.prepareAnimation("c");
  await queued(bank, "c");
  const latest = bank.prepareAnimation("latest");
  let forced = false;
  const deadline = setTimeout(() => { forced = true; gate.resolve(); }, 2_000);
  try {
    await Promise.all([old, b, c]);
    assert.equal(forced, false, "cancelled preparations settle before the active decode");
    await queued(bank, "latest");
    assert.equal(bank.pendingPages.size, 1, "only the current candidate owns a pending page");
    assert.ok(bank.frame("idle", 0));
    gate.resolve();
    await latest;
    assert.equal(decoded.filter((url) => /\/(?:b|c)\//.test(url)).length, 0);
    assert.equal(decoded.filter((url) => url.includes("/old/")).length, 1);
    assert.equal(bank.prepared.name, "latest");
  } finally { clearTimeout(deadline); gate.resolve(); await Promise.all([old, b, c, latest]); }
});

test("a current standalone page consumer keeps a superseded preparation's decode alive", async (t) => {
  const gate = Promise.withResolvers();
  const entered = Promise.withResolvers();
  let oldDecodes = 0;
  const bank = setup(t, async (url) => {
    if (url.includes("/old/")) { oldDecodes++; entered.resolve(); await gate.promise; }
  });
  bank.clips.set("old", clip);
  await bank.prepareAnimation("ready");
  const old = bank.prepareAnimation("old");
  await entered.promise;
  const shared = bank.loadPage("old", 0);
  const latest = bank.prepareAnimation("latest");
  try {
    await old;
    gate.resolve();
    assert.ok(await shared);
    await latest;
    assert.equal(oldDecodes, 1);
    assert.equal(bank.prepared.name, "latest");
  } finally { gate.resolve(); await Promise.all([old, shared, latest]); }
});
