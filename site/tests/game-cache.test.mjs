import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { gameAssetUrl } from "../game-assets.mjs";
import { SpriteBank } from "../sprite-bank.mjs";

test("mutable game manifests and images escape old immutable URLs and revalidate", async () => {
  const config = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url)));
  const gamePolicy = config.headers.find((route) => route.source === "/assets/game/(.*)");
  const cache = gamePolicy.headers.find((header) => header.key === "Cache-Control").value;
  assert.match(cache, /max-age=0/);
  assert.match(cache, /must-revalidate/);
  assert.doesNotMatch(cache, /immutable/);
  const requested = [];
  const fetch = globalThis.fetch;
  const Image = globalThis.Image;
  globalThis.fetch = async (url) => {
    requested.push(new URL(url));
    return new Response(await readFile(new URL("../assets/game/idle/clip.json", import.meta.url)));
  };
  globalThis.Image = class {
    async decode() {
      assert.ok(this.src.startsWith("blob:"));
    }
  };
  try {
    const bank = new SpriteBank(() => {});
    await bank.loadPage("idle", 0);
    const manifest = gameAssetUrl("manifest.json");
    assert.ok(manifest.search);
    assert.equal(requested.length, 2);
    for (const url of requested) assert.equal(url.search, manifest.search);
    assert.match(requested[0].pathname, /idle\/clip.json$/);
    assert.match(requested[1].pathname, /idle\/page-000.webp$/);
  } finally {
    globalThis.fetch = fetch;
    globalThis.Image = Image;
  }
});
