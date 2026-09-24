/** Abort ownership across queued worker and uncancellable bitmap decodes (PRD §13). */
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import { fixture, flush, rejection } from "./helpers/decoder-cancellation.mjs";

const sheet = (name) => new Blob([name]);

for (const local of [false, true]) {
  test(`pre-aborted request does no decoding (local=${local})`, async (t) => {
    let calls = 0;
    const { decoder, sent } = fixture(t, async () => { calls++; return {}; }, { local });
    const controller = new AbortController();
    controller.abort(new Error("no owner"));
    const observed = rejection(decoder.decode(sheet("cancelled"), controller.signal), controller.signal);
    await observed.done;
    assert.equal(calls, 0);
    assert.equal(sent.length, 0);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  });
}

test("queued cancellation skips atlas work while other owners keep the worker", async (t) => {
  const gate = Promise.withResolvers();
  const entered = [];
  const { decoder, worker, drain } = fixture(t, async (blob) => {
    const name = await blob.text();
    entered.push(name);
    if (name === "first") await gate.promise;
    return { name, close() {} };
  });
  const first = decoder.decode(sheet("first"));
  const controller = new AbortController();
  const cancelled = rejection(decoder.decode(sheet("cancelled"), controller.signal), controller.signal);
  const survivor = decoder.decode(sheet("survivor"));
  let settledBeforeDecode = false;
  try {
    await flush();
    controller.abort();
    await flush();
    settledBeforeDecode = cancelled.state.rejected;
    assert.deepEqual(entered, ["first"]);
    assert.equal(worker.terminated, false);
  } finally {
    gate.resolve();
    await Promise.allSettled([first, survivor, cancelled.done]);
    await drain();
  }
  assert.deepEqual(entered, ["first", "survivor"]);
  assert.equal(settledBeforeDecode, true, "abort settles before active decode finishes");
  await cancelled.done;
  assert.equal((await survivor).name, "survivor");
});

for (const mode of ["worker", "late-transfer", "cancel-send-failure", "local"]) {
  test(`active ${mode} cancellation closes its late image without fallback`, async (t) => {
    const gate = Promise.withResolvers();
    let calls = 0;
    let closed = 0;
    const { decoder, worker, drain } = fixture(t, () => { calls++; return gate.promise; }, {
      local: mode === "local", ignoreCancel: mode === "late-transfer", cancelThrows: mode === "cancel-send-failure",
    });
    const controller = new AbortController();
    const cancelled = rejection(decoder.decode(sheet("active"), controller.signal), controller.signal);
    try {
      await flush();
      controller.abort();
      await flush();
      assert.equal(cancelled.state.rejected, true);
      assert.equal(getEventListeners(controller.signal, "abort").length, 0);
      if (worker) assert.equal(worker.terminated, false);
    } finally {
      gate.resolve({ close: () => closed++ });
      await drain();
      await flush();
    }
    await cancelled.done;
    assert.equal(closed, 1);
    assert.equal(calls, 1, "cancellation must never invoke local fallback");
  });
}

for (const local of [false, true]) {
  test(`settlement removes the abort listener (local=${local})`, async (t) => {
    let closed = 0;
    const image = { close: () => closed++ };
    const { decoder, sent } = fixture(t, async () => image, { local });
    const controller = new AbortController();
    assert.equal(await decoder.decode(sheet("complete"), controller.signal), image);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    controller.abort();
    assert.equal(closed, 0, "the delivered image belongs to its caller");
    assert.equal(sent.filter((message) => message.cancel !== undefined).length, 0);
  });
}

for (const local of [false, true]) {
  test(`cancelled active failure does not fall back (local=${local})`, async (t) => {
    const gate = Promise.withResolvers();
    let calls = 0;
    const { decoder, drain } = fixture(t, () => { calls++; return gate.promise; }, { local });
    const controller = new AbortController();
    const cancelled = rejection(decoder.decode(sheet("bad"), controller.signal), controller.signal);
    await flush();
    controller.abort();
    gate.reject(new Error("late decode failure"));
    await cancelled.done;
    await drain();
    await flush();
    assert.equal(calls, 1);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  });
}

test("unknown and completed cancellation IDs cannot poison future worker requests", async (t) => {
  let calls = 0;
  const { decoder, worker, drain } = fixture(t, async () => ({ number: ++calls }));
  worker.postMessage({ cancel: 1 });
  assert.equal((await decoder.decode(sheet("first"))).number, 1);
  worker.postMessage({ cancel: 1 });
  worker.postMessage({ cancel: 2 });
  assert.equal((await decoder.decode(sheet("second"))).number, 2);
  await drain();
  assert.equal(calls, 2);
});

for (const outcome of ["failure", "dispose"]) {
  test(`${outcome} removes pending abort listeners`, async (t) => {
    const gate = Promise.withResolvers();
    const { decoder, sent } = fixture(t, () => gate.promise, { local: true });
    const controller = new AbortController();
    const result = decoder.decode(sheet("pending"), controller.signal);
    const rejected = assert.rejects(result, outcome === "failure" ? /bad image/ : /disposed/);
    if (outcome === "failure") gate.reject(new Error("bad image"));
    else { decoder.dispose(); gate.resolve({ close() {} }); }
    await rejected;
    await flush();
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    controller.abort();
    assert.equal(sent.length, 0);
  });
}
