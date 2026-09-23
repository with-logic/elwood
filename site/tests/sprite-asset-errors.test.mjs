/** Sprite failures retain the requested asset and original cause (PRD §13). */
import assert from "node:assert/strict";
import test from "node:test";
import { SpriteBank } from "../sprite-bank.mjs";

const clip = { fps: 24, pages: [{ file: "sheet.webp" }], frames: [{ page: 0, x: 0, y: 0, w: 1, h: 1, anchor: { x: 0, y: 0 }, socket: { x: 0, y: 0 } }] };
for (const stage of ["metadata-network", "json", "validation", "page-network", "blob", "decode"]) {
  test(`${stage} failure identifies its asset and retains its cause`, async (t) => {
    const original = { fetch: globalThis.fetch, Image: globalThis.Image };
    const cause = new Error(`failure during ${stage}`);
    globalThis.fetch = async (url) => {
      const metadata = new URL(url).pathname.endsWith("clip.json");
      if (stage === (metadata ? "metadata-network" : "page-network")) throw cause;
      if (metadata) {
        if (stage === "json") return new Response("not JSON");
        return Response.json(stage === "validation" ? {} : clip);
      }
      if (stage === "blob") return { ok: true, blob: async () => { throw cause; } };
      return new Response("pixels");
    };
    globalThis.Image = class { async decode() { if (stage === "decode") throw cause; } };
    const bank = new SpriteBank(() => {});
    t.after(() => { bank.dispose(); Object.assign(globalThis, original); });
    const path = ["metadata-network", "json", "validation"].includes(stage) ? "wave/clip.json" : "wave/sheet.webp";
    await assert.rejects(bank.prepare("wave"), (error) => {
      assert.ok(error.message.includes(path), error.message);
      assert.ok(error.cause instanceof Error);
      if (!["json", "validation"].includes(stage)) assert.equal(error.cause, cause);
      return true;
    });
  });
}

test("asset context bounds long paths and preserves non-Error causes", async () => {
  const { withSpriteAssetErrorContext } = await import("../sprite-asset-error.mjs");
  const path = "x".repeat(201);
  await assert.rejects(withSpriteAssetErrorContext(path, () => { throw null; }), (error) => {
    assert.equal(error.message, `Couldn’t load ${path.slice(0, 200)}.`);
    assert.equal(error.cause, null);
    return true;
  });
});

test("cancellation retains its original AbortError identity", async () => {
  const { withSpriteAssetErrorContext } = await import("../sprite-asset-error.mjs");
  const cause = new DOMException("canceled preparation", "AbortError");
  await assert.rejects(withSpriteAssetErrorContext("wave/sheet.webp", () => { throw cause; }), (error) => error === cause);
});
