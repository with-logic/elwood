/** Explicit readiness shares failure authority and releases canceled delivery (PRD §13). */
import assert from "node:assert/strict";
import { resolveObjectURL } from "node:buffer";
import test from "node:test";
import { SpriteBank } from "../sprite-bank.mjs";
import { LandingScene } from "../landing-scene.mjs";
import { World } from "../world.mjs";

const turn = () => new Promise((resolve) => setImmediate(resolve));
async function waitFor(predicate) {
  for (let i = 0; i < 100 && !predicate(); i++) await turn();
  assert.ok(predicate(), "expected asset work to reach the test boundary");
}
const clip = (name) => ({ name, fps: 24,
  pages: Array.from({ length: name === "wave" ? 6 : 2 }, (_, index) => ({ file: `${index}.webp` })),
  frames: Array.from({ length: name === "wave" ? 6 : 2 }, (_, page) => ({ page, x: 0, y: 0, w: 1, h: 1, anchor: { x: 0, y: 0 }, socket: { x: 0, y: 0 } })),
});
function fixture(t) {
  const original = { fetch: globalThis.fetch, Image: globalThis.Image };
  const requests = [], images = [], errors = [];
  globalThis.fetch = async (url) => {
    const path = new URL(url).pathname.split("/game/").at(-1);
    requests.push(path);
    return path.endsWith("clip.json") ? Response.json(clip(path.split("/")[0])) : new Response(path);
  };
  globalThis.Image = class {
    closed = 0;
    async decode() { this.path = await resolveObjectURL(this.src).text(); images.push(this); }
    close() { this.closed++; }
  };
  const bank = new SpriteBank((error) => errors.push(error));
  const scene = Object.create(LandingScene.prototype);
  Object.assign(scene, { bank, ready: true, requestVersion: 0, pressed: {}, pauses: new Set(),
    world: { player: { queuedAction: null } }, director: { interact() {} }, start() {},
    onError(error) { errors.push(error); },
  });
  t.after(() => { bank.dispose(); Object.assign(globalThis, original); });
  return { bank, scene, requests, images, errors };
}

for (const first of ["automatic", "explicit"]) for (const stage of ["metadata", "page"]) for (const order of ["before", "after"]) {
  test(`${first} starts first: automatic ${stage} failure ${order} explicit delivery cannot poison prepared rotation`, async (t) => {
    const { bank, requests, errors } = fixture(t);
    const automatic = Promise.withResolvers(), preparation = Promise.withResolvers();
    const originalFetch = globalThis.fetch;
    const path = stage === "metadata" ? "rotation/clip.json" : "rotation/0.webp";
    let stalled = false, automaticStarted = false;
    globalThis.fetch = (url, options) => {
      if (automaticStarted && new URL(url).pathname.endsWith(path) && !stalled) { stalled = true; return automatic.promise; }
      if (new URL(url).pathname.endsWith("wave/5.webp")) return preparation.promise;
      return originalFetch(url, options);
    };
    const startAutomatic = async () => {
      automaticStarted = true;
      if (stage === "metadata") bank.ensureMetadata("rotation");
      else { bank.clips.set("rotation", clip("rotation")); bank.frame("rotation", 0); }
      await waitFor(() => stalled);
    };
    if (first === "automatic") await startAutomatic();
    const pending = bank.prepareAnimation("wave");
    await waitFor(() => requests.includes("wave/4.webp"));
    if (first === "explicit") await startAutomatic();
    if (order === "before") { automatic.reject(new Error("obsolete automatic failure")); await turn(); }
    preparation.resolve(new Response("wave/5.webp"));
    assert.equal((await pending).name, "wave");
    bank.publishAnimation("wave");
    bank.activateAnimation("wave");
    if (order === "after") { automatic.reject(new Error("obsolete automatic failure")); await turn(); }
    assert.deepEqual(errors, []);
    assert.equal(bank.loads.failed.has(stage === "metadata" ? "rotation" : "rotation/0"), false);
    bank.activateAnimation("walk");
    bank.frame("rotation", 0);
    await waitFor(() => bank.pages.has("rotation/0"));
    assert.ok(bank.frame("rotation", 0));
  });
}

test("cleared delivery releases its sheets while active and outgoing poses remain alive", async (t) => {
  const { bank, scene, images } = fixture(t);
  await scene.request({ gesture: "wave" });
  bank.activateAnimation("wave");
  const current = bank.frame("wave", 0);
  await scene.request({ gesture: "jump" });
  const outgoing = bank.frame("jump", 0);
  bank.retainPoses(current, outgoing);
  scene.clearInput();
  assert.ok(images.filter((image) => image.path.startsWith("jump/") && image !== outgoing.page).every((image) => image.closed === 1));
  assert.equal(current.page.closed, 0);
  assert.equal(outgoing.page.closed, 0);
  bank.retainPoses(current);
  assert.equal(outgoing.page.closed, 1);
  assert.equal(bank.frame("wave", 5).page.closed, 0);
});

test("superseding delivered input invalidates queued recovery before releasing its owner", async (t) => {
  const { bank, scene, images } = fixture(t);
  await scene.request({ gesture: "wave" });
  scene.world.player.queuedAction = { gesture: "wave" };
  const pending = scene.request({ gesture: "jump" });
  assert.equal(scene.pressed.gesture, undefined);
  assert.equal(scene.world.player.queuedAction, null);
  assert.ok(images.filter((image) => image.path.startsWith("wave/")).every((image) => image.closed === 1));
  await pending;
  assert.equal(scene.pressed.gesture, "jump");
  bank.activateAnimation("jump");
  assert.equal(bank.frame("jump", 0).page.closed, 0);
});

for (const [input, name] of [[{ gesture: "wave" }, "wave"], [{ face: "back" }, "idle-back"]]) {
  test(`a consumed ${name} request owns its turn before the next paint`, async (t) => {
    const { bank, scene } = fixture(t);
    scene.world = new World();
    scene.world.canRender = (clipName, index) => !!bank.frame(clipName, index);
    scene.director.update = () => ({});
    await scene.request(input);
    const page = bank.frame(name, 0).page;
    scene.step(1 / 120);
    assert.equal(scene.world.player.turn.target, name);
    scene.clearInput();
    assert.equal(page.closed, 0, "consumed input is active before a paint can retain its pose");
    assert.equal(bank.frame(name, 0).page, page);
  });
}


test("entry-page preparation does not claim failures for other automatic sheets", async (t) => {
  const { bank, errors } = fixture(t);
  bank.clips.set("wave", clip("wave"));
  const automatic = Promise.withResolvers(), fetchAsset = globalThis.fetch;
  globalThis.fetch = (url, options) => new URL(url).pathname.endsWith("wave/1.webp")
    ? automatic.promise : fetchAsset(url, options);
  bank.frame("wave", 1);
  await bank.prepare("wave");
  automatic.reject(new Error("later sheet failed"));
  await turn();
  assert.equal(errors.length, 1);
  assert.equal(errors[0].message, "later sheet failed");
});
