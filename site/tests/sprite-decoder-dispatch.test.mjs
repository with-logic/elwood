/** Page-owned decode dispatch survives worker message-task races (PRD §13). */
import assert from "node:assert/strict";
import test from "node:test";
import { fixture, flush, rejection } from "./helpers/decoder-cancellation.mjs";

const sheet = (name) => new Blob([name]);

test("aborting queued B before A settles skips B even before cancellation messages arrive", async (t) => {
  const gate = Promise.withResolvers();
  const entered = [];
  const setup = fixture(t, async (blob) => {
    const name = await blob.text();
    entered.push(name);
    if (name === "A") await gate.promise;
    return { name, close() {} };
  }, { delayed: true });
  const a = setup.decoder.decode(sheet("A"));
  const controller = new AbortController();
  const b = rejection(setup.decoder.decode(sheet("B"), controller.signal), controller.signal);
  const c = setup.decoder.decode(sheet("C"));
  try {
    await setup.requests();
    assert.deepEqual(entered, ["A"]);
    controller.abort();
    // Resolve the active bitmap before delivering any cancellation task to the worker.
    gate.resolve();
    await flush();
    assert.deepEqual(entered, ["A"], "queued work must remain page-owned until A's reply");
    assert.equal(b.state.rejected, true);
    await setup.transport();
    assert.deepEqual(entered, ["A", "C"]);
    assert.equal((await c).name, "C");
  } finally {
    gate.resolve();
    await setup.transport();
    await setup.drain();
    await Promise.allSettled([a, b.done, c]);
  }
  await b.done;
});

for (const [cancelArrivesEarly, fails] of [[false, false], [true, false], [true, true]]) {
  test(`active cancellation retains physical ownership until reply (early=${cancelArrivesEarly}, fails=${fails})`, async (t) => {
    const gate = Promise.withResolvers();
    let closed = 0;
    const entered = [];
    const setup = fixture(t, async (blob) => {
      const name = await blob.text();
      entered.push(name);
      if (name === "A") {
        await gate.promise;
        if (fails) throw new Error("late decoding failure");
        return { close: () => closed++ };
      }
      return { name, close() {} };
    }, { delayed: true });
    const controller = new AbortController();
    const a = rejection(setup.decoder.decode(sheet("A"), controller.signal), controller.signal);
    const b = setup.decoder.decode(sheet("B"));
    try {
      await setup.requests();
      controller.abort();
      await flush();
      assert.equal(a.state.rejected, true);
      assert.equal(setup.sent.filter((message) => message.blob).length, 1);
      if (cancelArrivesEarly) await setup.requests();
      gate.resolve();
      await flush();
      assert.deepEqual(entered, ["A"]);
      assert.equal(setup.sent.filter((message) => message.blob).length, 1, "wait for the physical reply");
      await setup.replies();
      assert.equal(closed, fails ? 0 : 1, "cancelled images close before the successor is delivered");
      await setup.transport();
      assert.equal((await b).name, "B");
      assert.deepEqual(entered, ["A", "B"]);
      assert.equal(setup.worker.terminated, false);
    } finally {
      gate.resolve();
      await setup.transport();
      await setup.drain();
      await Promise.allSettled([a.done, b]);
    }
    await a.done;
  });
}

test("worker failure after active abort falls back only surviving page-queued owners", async (t) => {
  const gate = Promise.withResolvers();
  const entered = [];
  let closed = 0;
  const setup = fixture(t, async (blob) => {
    const name = await blob.text();
    entered.push(name);
    if (name === "A") { await gate.promise; return { close: () => closed++ }; }
    return { name };
  }, { delayed: true });
  const controller = new AbortController();
  const a = rejection(setup.decoder.decode(sheet("A"), controller.signal), controller.signal);
  const b = setup.decoder.decode(sheet("B"));
  await setup.requests();
  controller.abort();
  setup.worker.listeners.get("error")();
  assert.equal((await b).name, "B");
  assert.deepEqual(entered, ["A", "B"]);
  gate.resolve();
  await setup.transport();
  await setup.drain();
  await a.done;
  assert.equal(closed, 1);
});
