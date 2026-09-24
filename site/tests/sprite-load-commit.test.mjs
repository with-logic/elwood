/** Asset publication commits delivery before cancellation can win (PRD §13). */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { SpriteBank } from "../sprite-bank.mjs";

const clip = { fps: 24, pages: [{ file: "0.webp" }], frames: [{ page: 0, x: 0, y: 0,
  w: 1, h: 1, anchor: { x: 0, y: 0 }, socket: { x: 0, y: 0 } }] };

for (const stage of ["metadata", "page"]) test(`${stage} publication commits delivery before cancellation`, async (t) => {
  const originalFetch = globalThis.fetch;
  const bank = new SpriteBank(() => {});
  t.after(() => { bank.dispose(); globalThis.fetch = originalFetch; });
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches++;
    return stage === "metadata" ? Response.json(clip) : new Response("sheet");
  };
  const image = { close() {} };
  bank.decoder.decode = async () => image;
  if (stage === "page") bank.clips.set("wave", clip);
  const published = stage === "metadata" ? bank.clips : bank.pages;
  const key = stage === "metadata" ? "wave" : "wave/0";
  const owner = new AbortController();
  const load = (options) => stage === "metadata" ? bank.load("wave", options) : bank.loadPage("wave", 0, options);
  const initial = load({ signal: owner.signal }).then((value) => ({ value }), (error) => ({ error }));
  // Observe the public cache at microtask boundaries, without replacing its mutation methods.
  for (let poll = 0; poll < 100 && !published.has(key); poll++) await Promise.resolve();
  assert.equal(published.has(key), true);
  owner.abort();
  const successor = await load();
  const result = await initial;
  assert.equal(result.error, undefined, "visible publication must already commit the original delivery");
  assert.equal(successor, result.value);
  assert.equal(fetches, 1);
});

test("a throwing automatic error observer still releases the task and allows retry", () => {
  const bankUrl = new URL("../sprite-bank.mjs", import.meta.url).href;
  const script = `
    import { SpriteBank } from ${JSON.stringify(bankUrl)};
    const clip = ${JSON.stringify(clip)};
    let calls = 0;
    globalThis.fetch = async () => {
      if (++calls === 1) throw new Error("asset failed");
      return Response.json(clip);
    };
    const bank = new SpriteBank(() => { throw new Error("observer failed"); });
    const observed = new Promise((resolve) => process.once("unhandledRejection", resolve));
    bank.ensureMetadata("wave");
    const error = await observed;
    await new Promise((resolve) => setImmediate(resolve));
    const pending = bank.loads.automatic.size;
    bank.loads.retry("wave");
    bank.ensureMetadata("wave");
    await new Promise((resolve) => setImmediate(resolve));
    process.stdout.write(JSON.stringify({ error: error.message, pending, calls, loaded: bank.clips.has("wave") }));
    bank.dispose();
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", script], { encoding: "utf8", timeout: 5000 });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { error: "observer failed", pending: 0, calls: 2, loaded: true });
});
