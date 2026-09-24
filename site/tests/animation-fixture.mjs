/** Real bank asset boundaries for complete preparation tests (PRD §13). */
import assert from "node:assert/strict";
import { resolveObjectURL } from "node:buffer";
import { SpriteBank } from "../sprite-bank.mjs";
export const turn = () => new Promise((resolve) => setImmediate(resolve));
export async function waitFor(requested, path) {
  for (let i = 0; i < 100 && !requested.includes(path); i++) await turn();
  assert.ok(requested.includes(path), `Expected request: ${path}`);
}
export function fixture(t) {
  const original = { fetch: globalThis.fetch, Image: globalThis.Image };
  const gates = new Map(), requested = [], images = [], aborted = [];
  globalThis.fetch = async (url, { signal } = {}) => {
    const path = new URL(url).pathname.split("/game/").at(-1);
    requested.push(path);
    const gate = gates.get(path);
    if (gate) await new Promise((resolve, reject) => {
      gate.promise.then(resolve, reject);
      signal?.addEventListener("abort", () => {
        aborted.push(path);
        reject(signal.reason);
      }, { once: true });
    });
    const name = path.split("/")[0];
    if (path.endsWith("clip.json")) return Response.json({
      name, fps: 24, pages: Array.from({ length: name === "wave" ? 6 : 2 }, (_, i) => ({ file: `${i}.webp` })),
      frames: Array.from({ length: name === "wave" ? 6 : 2 }, (_, i) => ({ page: i, x: 0, y: 0, w: 1, h: 1, anchor: { x: 0, y: 0 }, socket: { x: 0, y: 0 } })),
    });
    return new Response(path);
  };
  globalThis.Image = class {
    closed = 0;
    async decode() {
      this.path = await resolveObjectURL(this.src).text();
      images.push(this);
    }
    close() { this.closed++; }
  };
  const errors = [];
  const bank = new SpriteBank((error) => errors.push(error));
  t.after(() => { bank.dispose(); Object.assign(globalThis, original); });
  return { bank, gates, requested, images, errors, aborted };
}
