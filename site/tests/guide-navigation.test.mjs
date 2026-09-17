/** Initial fragments and search focus must survive guide scroll-spy setup. */
import assert from "node:assert/strict";
import test from "node:test";

test("fragment alignment waits for load and follows the section anchor", async (t) => {
  const handlers = {}, nodes = new Map(), replaced = [], focused = [];
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, {
      id, handlers: {}, classList: { add() {}, remove() {} },
      addEventListener(name, fn) { this.handlers[name] = fn; },
      getAttribute() { return `#${id}`; },
      setAttribute() {}, removeAttribute() {},
      closest() { return { id, classList: this.classList }; },
      getBoundingClientRect() { return { top: this.top - globalThis.scrollY }; },
      scrollIntoView() { globalThis.scrollY = this.top - 100; },
      focus(options) { focused.push(options); },
    });
    return nodes.get(id);
  };
  node("index").top = 100;
  node("cli").top = 2000;
  const globals = {
    scrollY: 0,
    location: { hash: "#cli" },
    history: { replaceState(_state, _title, hash) { replaced.push(hash); } },
    addEventListener(name, fn) { handlers[name] = fn; },
    requestAnimationFrame(fn) { fn(); },
    document: {
      readyState: "interactive",
      activeElement: node("focused"),
      querySelector: node,
      querySelectorAll(selector) {
        if (selector === ".doc-section, .doc-section h2") return [node("index"), node("cli")];
        if (selector === ".docs-sidebar a") return [node("cli")];
        return [];
      },
      getElementById: node,
      addEventListener() {},
    },
  };
  for (const [key, value] of Object.entries(globals)) {
    const original = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    t.after(() => {
      if (original) Object.defineProperty(globalThis, key, original);
      else delete globalThis[key];
    });
  }
  await import("../guide/guide.mjs?fragment-regression");
  handlers.scroll();
  handlers.resize();
  assert.deepEqual(replaced, [], "early scroll must not replace the incoming fragment");
  handlers.load();
  assert.equal(globalThis.scrollY, 1900);
  assert.deepEqual(replaced, ["#cli"]);
  globals.location.hash = "#index";
  handlers.hashchange();
  assert.equal(globalThis.scrollY, 0);
  assert.deepEqual(replaced, ["#cli", "#index"]);
});
