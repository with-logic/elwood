/** Complete explicit gesture preparation and cancellation (PRD §13; docs/design/landing.md). */
import assert from "node:assert/strict";
import { resolveObjectURL } from "node:buffer";
import test from "node:test";
import { SpriteBank } from "../sprite-bank.mjs";
import { LandingScene } from "../landing-scene.mjs";

const turn = () => new Promise((resolve) => setImmediate(resolve));
async function waitFor(requested, path) {
  for (let i = 0; i < 100 && !requested.includes(path); i++) await turn();
  assert.ok(requested.includes(path), `Expected request: ${path}`);
}
function fixture(t) {
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

test("explicit readiness waits for every sheet and retains them through playback and cache churn", async (t) => {
  const { bank, gates, requested, images } = fixture(t);
  const background = Promise.withResolvers(), fetchAsset = globalThis.fetch;
  let first = true;
  globalThis.fetch = (url, options) => {
    if (String(url).includes("wave/clip.json") && first) { first = false; return background.promise; }
    return fetchAsset(url, options);
  };
  const stalled = bank.load("wave");
  const gate = Promise.withResolvers();
  gates.set("wave/5.webp", gate);
  let settled = false;
  const pending = bank.prepareAnimation("wave").then((clip) => { settled = true; return clip; });
  await waitFor(requested, "wave/5.webp");
  assert.equal(settled, false);
  gate.resolve();
  assert.equal((await pending).name, "wave");
  background.resolve(Response.json(bank.clips.get("wave")));
  await stalled;
  const duplicate = await bank.loadPage("wave", 5);
  assert.notEqual(bank.frame("wave", 5).page, duplicate);
  assert.equal(bank.pages.get("wave/5"), duplicate);
  bank.publishAnimation("wave");
  bank.activateAnimation("wave");
  for (let page = 0; page < 6; page++) assert.equal(bank.frame("wave", page).page.closed, 0);
  for (const name of ["jump", "land", "walk"]) await bank.prepare(name);
  for (let page = 0; page < 6; page++) assert.equal(bank.frame("wave", page).page.closed, 0);
  assert.equal(requested.filter((path) => path.startsWith("wave/") && path.endsWith("webp")).length, 7);
  assert.equal((await bank.prepareAnimation("wave")).name, "wave");
  bank.publishAnimation("missing");
  bank.activateAnimation("jump");
  assert.ok(images.filter((image) => image !== duplicate && image.path.startsWith("wave/")).every((image) => image.closed === 1));
  bank.dispose();
  await assert.rejects(bank.prepareAnimation("wave"), /disposed/);
  assert.ok(images.every((image) => image.closed === 1));
});

test("replacement cancels a stalled request without publishing it or closing the current pose", async (t) => {
  const { bank, gates, requested, aborted } = fixture(t);
  await bank.prepareAnimation("wave");
  bank.publishAnimation("wave");
  bank.activateAnimation("wave");
  const pose = bank.frame("wave", 0);
  bank.retainPoses(pose);
  gates.set("jump/0.webp", Promise.withResolvers());
  const obsolete = bank.prepareAnimation("jump");
  await waitFor(requested, "jump/0.webp");
  const latest = bank.prepareAnimation("land");
  assert.equal(await obsolete, null);
  assert.equal((await latest).name, "land");
  assert.deepEqual(aborted, ["jump/0.webp"]);
  assert.equal(pose.page.closed, 0);
  bank.publishAnimation("land");
  bank.activateAnimation("land");
  assert.equal(pose.page.closed, 0);
  bank.retainPoses();
  assert.equal(pose.page.closed, 1);
});

test("failed preparation releases partial sheets and leaves the displayed animation usable", async (t) => {
  const { bank, gates, requested, images } = fixture(t);
  await bank.prepareAnimation("wave");
  bank.publishAnimation("wave");
  bank.activateAnimation("wave");
  const gate = Promise.withResolvers();
  gates.set("jump/1.webp", gate);
  const pending = bank.prepareAnimation("jump");
  await waitFor(requested, "jump/1.webp");
  gate.reject(new Error("broken sheet"));
  await assert.rejects(pending, /broken sheet/);
  assert.equal(bank.frame("wave", 5).page.closed, 0);
  assert.equal(images.find((image) => image.path === "jump/0.webp").closed, 1);
  assert.equal(bank.clips.has("jump"), false);
});

function sceneFor(bank) {
  const scene = Object.create(LandingScene.prototype);
  Object.assign(scene, {
    bank, ready: true, requestVersion: 0, pressed: {}, pauses: new Set(), pending: new Set(),
    director: { interact() {} }, start() {}, onError(error) { throw error; },
  });
  return scene;
}

test("lazy entry loading cannot supersede explicit readiness; movement cancels delivery", async (t) => {
  const { bank, gates, requested } = fixture(t);
  const scene = sceneFor(bank);
  gates.set("wave/5.webp", Promise.withResolvers());
  const pending = scene.request({ gesture: "wave" });
  await waitFor(requested, "wave/5.webp");
  scene.prepare("walk");
  await turn();
  assert.equal(scene.pressed.gesture, undefined);
  scene.interact();
  await pending;
  assert.equal(scene.pressed.gesture, undefined);
  const next = scene.request({ face: "back" });
  await next;
  assert.equal(scene.pressed.face, "back");
});


test("delivered input retains every sheet while its predecessor recovers and another request loads", async (t) => {
  const { bank, gates, requested } = fixture(t);
  const scene = sceneFor(bank);
  await scene.request({ gesture: "wave" });
  scene.interact();
  for (let i = 0; i < 6; i++) assert.equal(bank.frame("wave", i).page.closed, 0);
  gates.set("jump/0.webp", Promise.withResolvers());
  const replacement = scene.request({ gesture: "jump" });
  await waitFor(requested, "jump/0.webp");
  bank.activateAnimation("wave");
  assert.equal(bank.frame("wave", 5).page.closed, 0);
  scene.clearInput();
  await replacement;
  assert.equal(bank.frame("wave", 5).page.closed, 0);
});


test("teardown aborts metadata and HTTP failures report instead of becoming readiness", async (t) => {
  const { bank, requested, aborted } = fixture(t);
  globalThis.fetch = async () => new Response("missing", { status: 404 });
  await assert.rejects(bank.prepareAnimation("wave"), /Couldn’t load wave/);
  assert.equal(bank.clips.size, 0);
  globalThis.fetch = async (url, { signal }) => new Promise((_resolve, reject) => {
    requested.push(String(url));
    signal.addEventListener("abort", () => { aborted.push("metadata"); reject(signal.reason); });
  });
  const pending = bank.prepareAnimation("wave");
  bank.dispose();
  assert.equal(await pending, null);
  assert.deepEqual(aborted, ["metadata"]);
});

test("cancellation between worker delivery and its continuation releases the transferred image", async (t) => {
  const { bank } = fixture(t);
  const original = globalThis.Worker;
  let deliver;
  globalThis.Worker = class {
    addEventListener(type, listener) { if (type === "message") this.receive = listener; }
    postMessage({ id }) { deliver = (image) => this.receive({ data: { id, image } }); }
    terminate() {}
  };
  t.after(() => { globalThis.Worker = original; });
  const pending = bank.prepareAnimation("wave");
  while (!deliver) await turn();
  const image = { closed: 0, close() { this.closed++; } };
  deliver(image);
  bank.cancelAnimation();
  assert.equal(await pending, null);
  assert.equal(image.closed, 1);
});
