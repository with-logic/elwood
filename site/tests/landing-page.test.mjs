import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { LandingScene } from "../landing-scene.mjs";

// Execute the real page controller with real assets. These rectangles are test
// fixtures, so this checks input/lifecycle behavior, not browser layout.
const root = new URL("../", import.meta.url);
const elements = new Map();
const listeners = new Map();
const frames = new Map();
let serial = 0;
let now = 0;
let scene;
let intersection;
function element(id) {
  if (elements.has(id)) return elements.get(id);
  const context = new Proxy(
    {
      measureText: () => ({ width: 220, actualBoundingBoxAscent: 220 }),
      getTransform: () => ({ e: 0, f: 0 }),
    },
    { get: (t, key) => t[key] ?? (() => {}) },
  );
  const e = {
    id,
    style: {},
    dataset: {},
    handlers: new Map(),
    children: [],
    textContent: "",
    tagName: "DIV",
    clientWidth: 1200,
    clientHeight: 800,
    offsetWidth: 500,
    hidden: false,
    addEventListener(type, handler) {
      this.handlers.set(type, handler);
    },
    fire(type, event = {}) {
      this.handlers.get(type)?.({ target: this, preventDefault() {}, ...event });
    },
    replaceChildren(...children) {
      this.children = children;
    },
    querySelectorAll() {
      return this.children;
    },
    querySelector(selector) {
      return this.children.find((child) => child.id === selector) ?? null;
    },
    getContext: () => context,
    getBoundingClientRect() {
      const names = [...elements].filter(([, other]) => other === this).map(([name]) => name);
      if (names.includes(".hero-title"))
        return { left: 72, top: 600, width: 1056, height: 180, bottom: 780 };
      if (names.includes(".line-1"))
        return { left: 300, top: 600, width: 600, height: 90, bottom: 690 };
      if (names.some((name) => name.startsWith(".word-")))
        return {
          left: names.includes(".word-agent") ? 300 : 500,
          top: names.includes(".word-agent") || names.includes(".word-sessions") ? 690 : 600,
          width: 200,
          height: 90,
          right: names.includes(".word-agent") ? 500 : 900,
          bottom: names.includes(".word-agent") || names.includes(".word-sessions") ? 780 : 690,
        };
      if (names.includes(".terminal"))
        return { left: 530, top: 72, width: 140, height: 98, bottom: 170 };
      return { left: 0, top: 0, width: 1200, height: 800, bottom: 800 };
    },
    focus() {
      document.activeElement = this;
    },
    attributes: {},
    setAttribute(key, value) {
      this.attributes[key] = value;
    },
    setPointerCapture(id) {
      this.capture = id;
    },
    hasPointerCapture(id) {
      return this.capture === id;
    },
    releasePointerCapture(id) {
      this.capture = null;
      this.fire("lostpointercapture", { pointerId: id });
    },
    showModal() {
      this.open = true;
    },
    close() {
      this.open = false;
      this.fire("close");
    },
    scrollIntoView() {
      this.scrolled = true;
      intersection([{ isIntersecting: true }]);
    },
  };
  elements.set(id, e);
  return e;
}
const html = await readFile(new URL("index.html", root), "utf8");
const buttons = [...html.matchAll(/<button([^>]*)>/g)].map(([, tag], i) => {
  const button = element(`button-${i}`);
  button.tagName = "BUTTON";
  button.dataset = Object.fromEntries(
    [...tag.matchAll(/data-(\w+)="([^"]+)"/g)].map(([, key, value]) => [key, value]),
  );
  for (const name of (tag.match(/class="([^"]+)"/)?.[1] ?? "").split(" "))
    if (name) elements.set(`.${name}`, button);
  return button;
});
function queryAll(selectors) {
  return buttons.filter((button) =>
    selectors.split(",").some((selector) => {
      const attrs = [...selector.matchAll(/\[data-(\w+)(?:="([^"]+)")?\]/g)];
      return (
        attrs.length &&
        attrs.every(
          ([, key, value]) =>
            key in button.dataset && (value === undefined || value === button.dataset[key]),
        )
      );
    }),
  );
}
globalThis.document = {
  documentElement: { dataset: {} },
  fonts: { ready: Promise.resolve() },
  hidden: false,
  createElement: (tag) => element(`${tag}-${++serial}`),
  querySelector: (selector) => queryAll(selector)[0] ?? element(selector),
  querySelectorAll: queryAll,
  addEventListener: (name, fn) => listeners.set(`document:${name}`, fn),
};
element(".line-1").children = [element(".word-headless"), element(".word-interactive")];
element(".line-2").children = [element(".word-agent"), element(".word-sessions")];
element(".hero-title").children = [element(".line-1"), element(".line-2")];
element(".hero-title").querySelectorAll = (selector) =>
  selector === ".word"
    ? [
        element(".word-headless"),
        element(".word-interactive"),
        element(".word-agent"),
        element(".word-sessions"),
      ]
    : [element(".line-1"), element(".line-2")];
globalThis.window = { addEventListener: (name, fn) => listeners.set(name, fn) };
globalThis.location = { href: "http://localhost/" };
globalThis.history = {
  replaceState(_state, _title, url) {
    location.href = String(url);
  },
};
globalThis.getComputedStyle = () => ({ columnGap: "20", fontSize: "100px" });
globalThis.matchMedia = () => ({ matches: false });
globalThis.devicePixelRatio = 2;
globalThis.ResizeObserver = class {
  constructor(fn) {
    this.fn = fn;
  }
  observe() {
    globalThis.relayout = this.fn;
    this.fn();
  }
};
globalThis.IntersectionObserver = class {
  constructor(fn) {
    intersection = fn;
  }
  observe() {
    intersection([{ isIntersecting: true }]);
  }
};
globalThis.requestAnimationFrame = (fn) => {
  const id = ++serial;
  frames.set(id, fn);
  return id;
};
globalThis.cancelAnimationFrame = (id) => frames.delete(id);
let releaseManifest;
let notifyManifest;
const manifestRequested = new Promise((resolve) => {
  notifyManifest = resolve;
});
const manifestReady = new Promise((resolve) => {
  releaseManifest = resolve;
});
globalThis.fetch = async (url) => {
  if (new URL(String(url), root).pathname.endsWith("/manifest.json")) {
    notifyManifest();
    await manifestReady;
  }
  return new Response(await readFile(new URL(String(url), root)));
};
globalThis.Image = class {
  async decode() {
    assert.equal((await readFile(new URL(this.src))).subarray(8, 12).toString(), "WEBP");
  }
};
const configure = LandingScene.prototype.configure;
LandingScene.prototype.configure = function (...args) {
  scene = this;
  return configure.apply(this, args);
};
await import("../landing.mjs");
LandingScene.prototype.configure = configure;
function key(type, code, extra = {}) {
  const event = {
    code,
    key: "",
    target: { tagName: "BODY" },
    preventDefault() {
      this.prevented = true;
    },
    ...extra,
  };
  listeners.get(type)(event);
  return event;
}
async function advance(count) {
  for (let i = 0; i < count; i++) {
    now += 1000 / 60;
    const pending = [...frames.values()];
    frames.clear();
    for (const fn of pending) fn(now);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
const button = (key, value) => buttons.find((b) => b.dataset[key] === value);

test("the connected HTML poster is laid out while animation metadata is still downloading", async () => {
  await manifestRequested;
  assert.equal(scene.ready, false);
  assert.equal(element(".hero").dataset.ready, undefined);
  const rope = element(".robot-rope");
  const poster = element(".robot-poster");
  assert.equal(Number.parseFloat(rope.style.top), 174);
  assert.equal(
    Number.parseFloat(rope.style.top) + Number.parseFloat(rope.style.height),
    Number.parseFloat(poster.style.top),
    "The lightweight cable must reach the poster without any sprite data",
  );
  assert.match(html, /<svg class="robot-rope"[^>]*>[\s\S]*?<path[^>]+d="M20 0 C4 35 36 65 20 100"/);
  releaseManifest();
});

test("landing keyboard aliases, shortcut dialog and focus recovery work through the real page handlers", async () => {
  for (let i = 0; i < 200 && !scene.ready; i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(scene.ready, true);
  assert.equal(element(".hero").dataset.ready, "", "The first canvas paint replaces the fallback");
  key("keydown", "ArrowLeft");
  // Rotation pauses while real sprite pages decode; simulated frames are not an I/O deadline.
  const movementDeadline = performance.now() + 5_000;
  while (scene.world.player.animation !== "walk-left" && performance.now() < movementDeadline)
    await advance(1);
  assert.equal(scene.world.player.animation, "walk-left");
  key("keydown", "KeyA");
  key("keyup", "ArrowLeft");
  assert.equal(scene.axis, -1);
  key("keyup", "KeyA");
  assert.equal(scene.axis, 0);
  const help = element(".help-toggle");
  help.focus();
  key("keydown", "Slash", { key: "?" });
  assert.equal(element("#robot-help").open, true);
  assert.equal(scene.raf, 0);
  key("keydown", "ArrowRight");
  assert.equal(scene.axis, 0, "Modal controls must not move the robot");
  element(".help-close").fire("click");
  assert.equal(document.activeElement, help);
  assert.ok(scene.raf);
  element("#terminal-demo").open = true;
  key("keydown", "Slash", { key: "?" });
  key("keydown", "ArrowRight");
  assert.equal(element("#robot-help").open, false);
  assert.equal(scene.axis, 0);
  element("#terminal-demo").open = false;
  key("keydown", "KeyP");
  assert.equal(scene.raf, 0);
  key("keydown", "ArrowRight");
  assert.equal(scene.axis, 0);
  key("keydown", "KeyP");
  key("keydown", "ArrowRight");
  assert.equal(scene.axis, 1);
  key("keyup", "ArrowRight");
});

test("landing controls leave forms and native button activation alone, and clear held keys on blur", () => {
  assert.equal(key("keydown", "Space", { target: { tagName: "BUTTON" } }).prevented, undefined);
  assert.equal(key("keydown", "KeyA", { target: { tagName: "INPUT" } }).prevented, undefined);
  assert.equal(key("keydown", "KeyA", { metaKey: true }).prevented, undefined);
  key("keydown", "ShiftLeft");
  key("keydown", "ShiftRight");
  assert.equal(scene.sprint, true);
  key("keyup", "ShiftLeft");
  assert.equal(scene.sprint, true);
  key("keyup", "ShiftRight");
  assert.equal(scene.sprint, false);
  key("keydown", "KeyA");
  assert.equal(scene.axis, -1);
  listeners.get("blur")();
  assert.equal(scene.axis, 0);
  assert.equal(scene.raf, 0);
  listeners.get("focus")();
  key("keydown", "ArrowLeft");
  key("keyup", "ArrowLeft");
  assert.equal(scene.axis, 0, "A stale alias must not survive blur");
});

test("Play returns to the hero and the home button re-centres him", async () => {
  intersection([{ isIntersecting: false }]);
  assert.equal(scene.raf, 0);
  assert.equal(key("keydown", "Space").prevented, undefined);
  key("keydown", "Slash", { key: "?" });
  button("action", "play").fire("click");
  assert.equal(element(".hero").scrolled, true);
  assert.ok(scene.raf);
  key("keydown", "ArrowRight");
  await advance(30);
  key("keyup", "ArrowRight");
  button("command", "reset").fire("click");
  await advance(2);
  assert.equal(scene.world.player.x, scene.homeSpot.x);
  scene.pause("test", true);
});

test("the headline is fitted and becomes a ledge", async () => {
  scene.pause("test", false);
  globalThis.relayout();
  const fitted = [element(".line-1"), element(".line-2")].map((line) =>
    Number.parseFloat(line.style.fontSize),
  );
  assert.ok(
    fitted.every((size) => size > 0) && Math.abs(fitted[0] / fitted[1] - 2) < 0.001,
    "Each headline line is fitted to the poster width and both shrink together",
  );
  assert.equal(scene.world.platforms[0]?.id, "heading", "The wide headline becomes a ledge");
  scene.home();
  assert.equal(scene.world.player.support?.id, "heading", "Home puts him back on the lettering");
  key("keydown", "ArrowDown");
  await advance(1);
  key("keyup", "ArrowDown");
  await advance(2);
  scene.pause("test", true);
});

test("pointer and keyboard pickup route through the real scene and release without recapture", async () => {
  scene.pause("test", false);
  scene.configure({ ...scene.config, platforms: [] }, true);
  const grip = element(".robot-grip");
  grip.fire("pointerdown", { button: 0, pointerId: 7, clientX: 600, clientY: 460 });
  assert.equal(scene.dragging, true);
  assert.equal(grip.capture, 7);
  grip.fire("pointermove", { pointerId: 7, clientX: 700, clientY: 300 });
  await advance(12);
  assert.equal(scene.world.player.mode, "drag");
  grip.fire("pointerup", { pointerId: 7 });
  grip.fire("click", { detail: 1 });
  assert.equal(scene.dragging, false);
  assert.equal(grip.capture, null);
  grip.fire("click", { detail: 0 });
  assert.equal(scene.dragging, true);
  const x = scene.world.player.x;
  grip.fire("keydown", { code: "ArrowRight", stopPropagation() {} });
  assert.ok(scene.world.player.x > x);
  grip.fire("keydown", { code: "Escape", stopPropagation() {} });
  assert.equal(scene.dragging, false);
  scene.pause("test", true);
});

test("permanent departure disposes the scene while bfcache preserves it", () => {
  listeners.get("pagehide")({ persisted: true });
  assert.equal(scene.bank.disposed, false);
  listeners.get("pagehide")({ persisted: false });
  assert.equal(scene.bank.disposed, true);
  assert.equal(scene.bank.pages.size, 0);
  assert.equal(scene.lastPose, null);
  assert.equal(scene.ready, false);
});
