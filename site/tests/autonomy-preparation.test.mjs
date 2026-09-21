/** Automatic preparation belongs to one task, through cancellation and display activation. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { LandingScene } from "../landing-scene.mjs";

const root = new URL("../", import.meta.url);
const context = new Proxy({ getTransform: () => ({ e: 0, f: 0 }) }, {
  get: (target, key) => target[key] ?? (() => {}),
});
const canvas = () => ({ width: 1000, height: 800, getContext: () => context });
globalThis.document = { createElement: canvas };
globalThis.matchMedia = () => ({ matches: false });
globalThis.devicePixelRatio = 1;
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};
globalThis.Image = class { async decode() {} };
const fetchAsset = async (url) => new Response(await readFile(fileURLToPath(new URL(String(url), root))));
const moment = () => ({ kind: "moment", name: "wave", sent: false, seen: false, elapsed: 0, hold: 3, fits: true });

for (const ending of ["expiry", "replacement"]) {
  test(`automatic ${ending} releases stale preparation consumers before a current gesture paints`, async () => {
    globalThis.fetch = fetchAsset;
    const own = new LandingScene(canvas());
    await own.boot();
    const gates = [Promise.withResolvers(), Promise.withResolvers()];
    const entered = [Promise.withResolvers(), Promise.withResolvers()];
    const signals = [];
    let url;
    globalThis.fetch = async (input, options) => {
      if (String(input).includes("wave/page-001.webp")) {
        url = String(input);
        const index = signals.length;
        signals.push(options.signal);
        entered[index].resolve();
        await gates[index].promise; // Deliberately ignore abort: consumers must detach promptly.
      }
      return fetchAsset(input);
    };
    const old = moment();
    own.director.task = old;
    try {
      own.step(1 / 120);
      await entered[0].promise;
      const stale = own.bank.preparationTail;
      const consumer = own.bank.sources.pending.get(url);
      for (let i = 0; i < 12 * 120; i++) own.step(1 / 120);
      assert.equal(own.director.task, old, "complete automatic preparation gets more than eight seconds");
      assert.equal(old.sent, false);
      assert.equal(signals[0].aborted, false);
      if (ending === "expiry") {
        for (let i = 0; i < 25 * 120 && own.director.task === old; i++) own.step(1 / 120);
        assert.notEqual(own.director.task, old, "automatic preparation still has a bounded deadline");
      } else own.director.task = moment(); // Same animation, different exact owner.
      assert.equal(signals[0].aborted, true, "task replacement actively aborts stale download ownership");
      assert.equal(consumer.consumers, 0);
      assert.equal(own.bank.sources.pending.has(url), false);
      await stale;
      if (ending === "expiry") own.director.task = moment();
      const current = own.director.task;
      own.step(1 / 120);
      await entered[1].promise;
      const replacement = own.bank.preparationTail;
      for (let i = 0; i < 20 * 120; i++) own.step(1 / 120);
      assert.equal(own.director.task, current);
      gates[0].resolve();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(signals[1].aborted, false, "late stale completion cannot cancel the same-name replacement");
      assert.equal(own.pendingPreparations.get("wave")(), true);
      gates[1].resolve();
      await replacement;
      for (let i = 0; i < 360 && own.bank.activeName !== "wave"; i++) {
        own.step(1 / 120);
        own.paint(1 / 120);
      }
      assert.equal(current.sent, true);
      assert.equal(own.director.task, current, "preparation time does not consume playback lifetime");
      assert.ok(current.elapsed < 3);
      assert.equal(own.bank.activeName, "wave");
      assert.equal(own.pose().clip.name, "wave");
      assert.ok(own.pose().page, "the current candidate activates as drawable artwork");
    } finally {
      gates.forEach((gate) => gate.resolve());
      own.pause("test", true);
      await own.bank.preparationTail;
      globalThis.fetch = fetchAsset;
    }
  });
}
