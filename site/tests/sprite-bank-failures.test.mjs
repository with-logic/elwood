/** Asset failures surface promptly and repeated paints share one pending consumer. */
import assert from "node:assert/strict";
import test from "node:test";
import { SpriteBank } from "../sprite-bank.mjs";

const clip = { pages: [{ file: "0.webp" }, { file: "1.webp" }], frames: [{ page: 0 }, { page: 1 }] };
function bankFixture(t, onError = () => {}) {
  const fetch = globalThis.fetch, Image = globalThis.Image;
  t.after(() => { globalThis.fetch = fetch; globalThis.Image = Image; });
  const bank = new SpriteBank(onError);
  bank.clips.set("idle", clip);
  return bank;
}

test("preparation reports a real sheet failure and aborts a stalled sibling without waiting", async (t) => {
  const bank = bankFixture(t);
  const gate = Promise.withResolvers();
  let sibling;
  globalThis.fetch = async (url, { signal }) => {
    if (String(url).includes("0.webp")) return new Response("", { status: 503 });
    sibling = signal;
    await gate.promise; // emulate a transport that ignores abort
    throw new Error("late sibling failure");
  };
  let forced = false;
  const deadline = setTimeout(() => { forced = true; gate.resolve(); }, 1_000);
  try {
    await assert.rejects(bank.prepareAnimation("idle"), /idle\/0.webp \(HTTP 503\)/);
    assert.equal(forced, false, "a known error cannot wait for another download");
    assert.equal(sibling.aborted, true);
    assert.equal(bank.prepared, null);
  } finally {
    clearTimeout(deadline);
    gate.resolve();
    await new Promise((resolve) => setImmediate(resolve));
  }
});

test("a ready sheet decodes and releases its object URL while another download is stalled", async (t) => {
  const bank = bankFixture(t);
  const gate = Promise.withResolvers(), decoded = Promise.withResolvers();
  let url;
  const revoke = URL.revokeObjectURL;
  const revoked = [];
  URL.revokeObjectURL = (value) => { revoked.push(value); revoke(value); };
  t.after(() => { URL.revokeObjectURL = revoke; });
  globalThis.Image = class { async decode() { url = this.src; decoded.resolve(); } };
  globalThis.fetch = async (input) => {
    if (String(input).includes("1.webp")) await gate.promise;
    return new Response(String(input));
  };
  const preparation = bank.prepareAnimation("idle");
  let forced = false;
  const deadline = setTimeout(() => { forced = true; gate.resolve(); }, 1_000);
  try {
    await decoded.promise;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(forced, false, "decoding must pipeline with remaining downloads");
    assert.ok(revoked.includes(url));
    gate.resolve();
    await preparation;
  } finally { clearTimeout(deadline); gate.resolve(); await preparation; }
});

test("a thousand missing-page paints retain one consumer and deliver one error", async (t) => {
  const errors = [];
  const bank = bankFixture(t, (error) => errors.push(error));
  const gate = Promise.withResolvers();
  globalThis.fetch = async () => { await gate.promise; return new Response("", { status: 503 }); };
  for (let i = 0; i < 1_000; i++) assert.equal(bank.frame("idle", 0), null);
  const pending = bank.pendingPages.get("idle/0");
  try {
    assert.equal(pending.consumers, 1);
    gate.resolve();
    await assert.rejects(pending.promise, /HTTP 503/);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(errors.length, 1);
  } finally { gate.resolve(); await pending.promise.catch(() => {}); }
});

for (const value of [null, [], {}, { pages: [], frames: [] },
  { pages: {}, frames: clip.frames }, { pages: clip.pages, frames: [] },
  { pages: [{ file: "  " }], frames: [{ page: 0 }] },
  { pages: [null], frames: [{ page: 0 }] }, { pages: [{ file: "" }], frames: [{ page: 0 }] },
  { pages: [{ file: 3 }], frames: [{ page: 0 }] }, { pages: clip.pages, frames: {} },
  { pages: clip.pages, frames: [null] }, ...[-1, 0.5, 2, "0"].map((page) => ({ pages: clip.pages, frames: [{ page }] }))]) {
  test(`invalid clip metadata is rejected before caching: ${JSON.stringify(value)}`, async (t) => {
    const bank = bankFixture(t);
    globalThis.fetch = async () => new Response(JSON.stringify(value));
    await assert.rejects(bank.load("wave"), (error) => {
      assert.equal(error.message, "Couldn’t read animation metadata wave/clip.json. Try again.");
      assert.ok(error.cause instanceof Error);
      return true;
    });
    assert.equal(bank.clips.has("wave"), false);
  });
}

test("metadata parse errors keep bounded sanitized context and support fresh retry", async (t) => {
  const bank = bankFixture(t);
  let attempts = 0;
  globalThis.fetch = async () => new Response(++attempts === 1 ? "{private invalid bytes" : JSON.stringify(clip));
  await assert.rejects(bank.load("wave<>"), (error) => {
    assert.match(error.message, /^Couldn’t read animation metadata wave/);
    assert.doesNotMatch(error.message, /private|[<>]/);
    assert.ok(error.cause instanceof SyntaxError);
    return true;
  });
  assert.equal(bank.clips.has("wave<>"), false);
  assert.deepEqual(await bank.load("wave<>"), clip);
});


test("preparation failure preserves a sibling download still owned by another consumer", async (t) => {
  const bank = bankFixture(t);
  const failure = Promise.withResolvers(), gate = Promise.withResolvers(), entered = Promise.withResolvers();
  let sibling;
  globalThis.Image = class { async decode() {} };
  globalThis.fetch = async (url, { signal }) => {
    if (String(url).includes("0.webp")) { await failure.promise; return new Response("", { status: 503 }); }
    sibling = signal;
    entered.resolve();
    await gate.promise;
    return new Response("shared");
  };
  const preparation = bank.prepareAnimation("idle");
  const rejected = assert.rejects(preparation, /HTTP 503/);
  await entered.promise;
  const shared = bank.loadPage("idle", 1);
  try {
    failure.resolve();
    await rejected;
    assert.equal(sibling.aborted, false);
    gate.resolve();
    assert.ok(await shared);
  } finally { failure.resolve(); gate.resolve(); await Promise.all([rejected, shared]); }
});

test("bank metadata downloads report bounded metadata context", async (t) => {
  const bank = bankFixture(t);
  globalThis.fetch = async () => new Response("", { status: 503 });
  await assert.rejects(bank.load("x".repeat(300)), (error) => {
    assert.match(error.message, /^Couldn’t load animation metadata /);
    assert.ok(error.message.length <= 230);
    assert.equal(error.cause.message, "HTTP 503");
    return true;
  });
});
