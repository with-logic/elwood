/** Sheet downloads deduplicate concurrent work and preserve mutable asset revalidation. */
import assert from "node:assert/strict";
import test from "node:test";
import { SpriteSources } from "../sprite-sources.mjs";

test("concurrent sheet loads share bytes but later loads revalidate", async () => {
  const fetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    return new Response(`revision-${requests.length}`);
  };
  try {
    const sources = new SpriteSources();
    const [first, duplicate] = await Promise.all([sources.load("wave/0.webp"), sources.load("wave/0.webp")]);
    assert.equal(first, duplicate);
    assert.equal(requests.length, 1);
    assert.equal(await (await sources.load("wave/0.webp")).text(), "revision-2");
    assert.equal(requests.length, 2);
    assert.ok(requests.every(({ options }) => options.cache === "no-cache"));
    assert.equal(sources.pending.size, 0);
  } finally { globalThis.fetch = fetch; }
});

test("HTTP failures identify the sheet and status without URL credentials or query text", async () => {
  const fetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async () => new Response("image", { status: ++attempts === 1 ? 503 : 200 });
  try {
    const sources = new SpriteSources();
    const url = "https://private:secret@example.com/assets/game/wave/0.webp?token=secret";
    await assert.rejects(sources.load(url), (error) => {
      assert.equal(error.message, "Couldn’t load animation sheet wave/0.webp (HTTP 503). Try again.");
      assert.equal(error.cause.message, "HTTP 503");
      return true;
    });
    assert.equal(await (await sources.load(url)).text(), "image");
  } finally { globalThis.fetch = fetch; }
});

test("network and response-body failures retain their cause and can retry", async () => {
  const fetch = globalThis.fetch;
  try {
    for (const phase of ["network", "body"]) {
      const cause = new Error("internal browser failure");
      let attempts = 0;
      globalThis.fetch = async () => {
        if (++attempts > 1) return new Response("recovered");
        if (phase === "network") throw cause;
        return { ok: true, blob: async () => { throw cause; } };
      };
      const sources = new SpriteSources();
      await assert.rejects(sources.load("wave/1.webp"), (error) => {
        assert.equal(error.message, "Couldn’t load animation sheet wave/1.webp. Try again.");
        assert.equal(error.cause, cause);
        return true;
      });
      assert.equal(sources.pending.size, 0);
      assert.equal(await (await sources.load("wave/1.webp")).text(), "recovered");
    }
  } finally { globalThis.fetch = fetch; }
});

test("cancelling one source consumer preserves another current consumer", async (t) => {
  const original = globalThis.fetch;
  const gate = Promise.withResolvers();
  let signal;
  let requests = 0;
  globalThis.fetch = async (_url, options) => {
    requests++;
    signal = options.signal;
    await gate.promise;
    return new Response("shared bytes");
  };
  t.after(() => { gate.resolve(); globalThis.fetch = original; });
  const sources = new SpriteSources();
  const cancelled = new AbortController();
  const stale = sources.load("wave/0.webp", cancelled.signal);
  const rejected = assert.rejects(stale, { name: "AbortError" });
  const current = sources.load("wave/0.webp");
  cancelled.abort();
  await rejected;
  assert.equal(signal.aborted, false);
  gate.resolve();
  assert.equal(await (await current).text(), "shared bytes");
  assert.equal(requests, 1);
});

test("last consumer cancellation releases stalled work and ignores its late completion", async (t) => {
  const original = globalThis.fetch;
  const gates = [Promise.withResolvers(), Promise.withResolvers()];
  const signals = [];
  globalThis.fetch = async (_url, { signal }) => {
    const index = signals.push(signal) - 1;
    await gates[index].promise; // deliberately ignore abort to exercise late completion
    return new Response(`revision-${index}`);
  };
  t.after(() => { for (const gate of gates) gate.resolve(); globalThis.fetch = original; });
  const sources = new SpriteSources();
  const cancelled = new AbortController();
  const stale = sources.load("wave/0.webp", cancelled.signal);
  const rejected = assert.rejects(stale, { name: "AbortError" });
  cancelled.abort();
  await rejected;
  assert.equal(signals[0].aborted, true);
  assert.equal(sources.pending.size, 0);
  const current = sources.load("wave/0.webp");
  gates[0].resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sources.pending.size, 1, "stale completion cannot delete the new request");
  gates[1].resolve();
  assert.equal(await (await current).text(), "revision-1");
  assert.equal(signals.length, 2);
});


test("metadata HTTP failures identify their kind and preserve safe context", async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async () => new Response("", { status: 404 });
  const sources = new SpriteSources();
  await assert.rejects(sources.load("https://user:secret@host/wave/clip.json?private=token", undefined, "metadata"), (error) => {
    assert.equal(error.message, "Couldn’t load animation metadata wave/clip.json (HTTP 404). Try again.");
    assert.equal(error.cause.message, "HTTP 404");
    return true;
  });
});
