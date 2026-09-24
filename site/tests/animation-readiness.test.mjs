/** Complete explicit gesture preparation and cancellation (PRD §13; docs/design/landing.md). */
import assert from "node:assert/strict";
import test from "node:test";
import { fixture, turn, waitFor } from "./animation-fixture.mjs";
test("explicit readiness waits for every sheet and retains them through playback and cache churn", async (t) => {
  const { bank, gates, requested, images } = fixture(t);
  const metadata = Promise.withResolvers();
  gates.set("wave/clip.json", metadata);
  const stalled = bank.load("wave");
  const gate = Promise.withResolvers();
  gates.set("wave/5.webp", gate);
  let settled = false;
  const pending = bank.prepareAnimation("wave").then((clip) => { settled = true; return clip; });
  await waitFor(requested, "wave/clip.json");
  assert.equal(requested.includes("wave/0.webp"), false);
  metadata.resolve();
  await stalled;
  await waitFor(requested, "wave/5.webp");
  assert.equal(settled, false);
  gate.resolve();
  assert.equal((await pending).name, "wave");
  const shared = await bank.loadPage("wave", 5);
  assert.equal(bank.frame("wave", 5).page, shared);
  assert.equal(bank.pages.get("wave/5"), shared);
  assert.equal(bank.ensureEntryPage("wave"), true);
  bank.publishAnimation("wave");
  bank.activateAnimation("wave");
  for (const [name, count] of [["idle", 2], ["rotation", 2], ["wave", 6]])
    for (let page = 0; page < count; page++) {
      assert.equal(bank.frame(name, page).page.closed, 0);
      assert.ok(bank.animations.activeOwner.pages.has(`${name}/${page}`));
    }
  for (const name of ["jump", "land", "walk"]) await bank.prepare(name);
  for (let page = 0; page < 6; page++) assert.equal(bank.frame("wave", page).page.closed, 0);
  assert.equal(requested.filter((path) => path.startsWith("wave/") && path.endsWith("webp")).length, 6);
  assert.equal((await bank.prepareAnimation("wave")).name, "wave");
  bank.publishAnimation("missing");
  bank.activateAnimation("jump");
  assert.ok(images.filter((image) => image !== shared && image.path.startsWith("wave/")).every((image) => image.closed === 1));
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
  const cached = images.find((image) => image.path === "jump/0.webp");
  assert.equal(cached.closed, [...bank.pages.values()].includes(cached) ? 0 : 1);
  assert.equal(bank.animations.candidateOwner, null);
  assert.equal(bank.animations.page("jump/0"), undefined);
});

test("teardown aborts metadata and HTTP failures report instead of becoming readiness", async (t) => {
  const { bank, requested, aborted } = fixture(t);
  globalThis.fetch = async () => new Response("missing", { status: 404 });
  await assert.rejects(bank.prepareAnimation("wave"), /Couldn’t load idle\/clip.json/);
  assert.equal(bank.clips.size, 0);
  globalThis.fetch = async (url, { signal }) => new Promise((_resolve, reject) => {
    requested.push(String(url));
    signal.addEventListener("abort", () => { aborted.push("metadata"); reject(signal.reason); });
  });
  const pending = bank.prepareAnimation("wave");
  for (let i = 0; i < 100 && !requested.length; i++) await turn();
  assert.ok(requested.length, "metadata fetch must start before teardown");
  bank.dispose();
  assert.equal(await pending, null);
  assert.deepEqual(aborted, ["metadata", "metadata", "metadata"]);
});

test("cancellation between worker delivery and its continuation releases the transferred image", async (t) => {
  const original = globalThis.Worker;
  let deliver;
  globalThis.Worker = class {
    addEventListener(type, listener) { if (type === "message") this.receive = listener; }
    postMessage({ id }) { deliver = (image) => this.receive({ data: { id, image } }); }
    terminate() {}
  };
  t.after(() => { globalThis.Worker = original; });
  const { bank } = fixture(t);
  const pending = bank.prepareAnimation("wave");
  for (let i = 0; i < 100 && !deliver; i++) await turn();
  assert.equal(typeof deliver, "function", "worker delivery must become available");
  const image = { closed: 0, close() { this.closed++; } };
  const pendingPage = bank.pendingPages.values().next().value;
  assert.ok(pendingPage, "page decode must still have a pending ownership task");
  deliver(image);
  bank.cancelPreparation();
  assert.equal(await pending, null);
  // Caller cancellation is prompt; late worker resources release when their task settles.
  await pendingPage;
  assert.equal(image.closed, 1);
});
