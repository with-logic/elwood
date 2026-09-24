/** Initial manifest diagnostics retain asset context and the original cause (PRD §13). */
import assert from "node:assert/strict";
import test from "node:test";
import { LandingScene } from "../landing-scene.mjs";

for (const stage of ["network", "http", "json"]) {
  test(`manifest ${stage} failure reports its path without starting the scene`, async (t) => {
    const original = { fetch: globalThis.fetch, document: globalThis.document,
      matchMedia: globalThis.matchMedia, cancelAnimationFrame: globalThis.cancelAnimationFrame };
    const context = new Proxy({}, { get: () => () => {} });
    const canvas = () => ({ getContext: () => context });
    globalThis.document = { createElement: canvas };
    globalThis.matchMedia = () => ({ matches: false });
    globalThis.cancelAnimationFrame = () => {};
    const cause = new Error("manifest offline");
    globalThis.fetch = async (url) => {
      assert.ok(new URL(url).pathname.endsWith("manifest.json"));
      if (stage === "network") throw cause;
      return stage === "http" ? new Response(null, { status: 503 }) : new Response("not JSON");
    };
    const errors = [];
    let starts = 0;
    const scene = new LandingScene(canvas(), { onError: (error) => errors.push(error), onReady: () => starts++ });
    t.after(() => { scene.dispose(); Object.assign(globalThis, original); });
    await scene.boot();
    assert.equal(scene.ready, false);
    assert.equal(starts, 0);
    assert.equal(errors.length, 1);
    assert.ok(errors[0].message.startsWith("Couldn’t load manifest.json."), errors[0].message);
    if (stage === "network") assert.equal(errors[0].cause, cause);
    else if (stage === "http") assert.equal(errors[0].cause.message, "HTTP 503");
    else {
      assert.ok(errors[0].cause instanceof SyntaxError);
      assert.ok(errors[0].cause.message.includes("not JSON"), errors[0].cause.message);
    }
  });
}
