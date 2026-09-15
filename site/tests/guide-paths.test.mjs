/** Verify guide assets and exports on Vercel's slashless route. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const site = new URL("../", import.meta.url);
const html = await readFile(new URL("guide/index.html", site), "utf8");

for (const route of ["/guide", "/guide/"]) {
  test(`guide assets and Markdown links resolve to real files from ${route}`, async () => {
    const page = new URL(route, "https://elwood.bot");
    const references = [...html.matchAll(/(?:href|src)="([^"]+)"/g)]
      .map((match) => new URL(match[1], page))
      .filter(
        (url) =>
          url.origin === page.origin &&
          /\.(css|mjs|md|txt|ico|webp|png|webmanifest)$/.test(url.pathname),
      );
    assert.ok(references.length > 15);
    for (const url of references) {
      const data = await readFile(new URL(url.pathname.slice(1), site));
      assert.ok(data.length, `${url.href} must resolve to a nonempty deployed file`);
    }
  });
}

test("guide search and Markdown copy work from the slashless production route", async (t) => {
  const nodes = new Map();
  const copied = [];
  const requests = [];
  const node = (key) => {
    if (!nodes.has(key))
      nodes.set(key, {
        textContent: "",
        value: "sessions",
        dataset: { slug: "index" },
        handlers: {},
        addEventListener(name, handler) {
          this.handlers[name] = handler;
        },
        focus() {},
        showModal() {
          this.open = true;
        },
        close() {},
        append() {},
        replaceChildren() {},
      });
    return nodes.get(key);
  };
  const globals = {
    scrollY: 0,
    document: {
      activeElement: node("focus"),
      querySelector: node,
      querySelectorAll: (selector) =>
        [".copy-section", "#copy-all-side"].includes(selector) ? [node(selector)] : [],
      createElement: () => node(Symbol()),
      addEventListener() {},
    },
    addEventListener() {},
    navigator: {
      clipboard: {
        async writeText(text) {
          copied.push(text);
        },
      },
    },
    setTimeout() {},
    async fetch(reference) {
      const url = new URL(reference, "https://elwood.bot/guide");
      requests.push(url.pathname);
      try {
        return new Response(await readFile(new URL(url.pathname.slice(1), site)));
      } catch {
        return new Response("Not found", { status: 404 });
      }
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
  await import("../guide/guide.mjs?slashless-route-test");
  await node("#search-open").handlers.click();
  assert.match(node("#search-status").textContent, /sections found/);
  await node(".copy-section").handlers.click();
  await node("#copy-all-side").handlers.click();
  assert.deepEqual(requests, ["/guide/search.json", "/guide/index.md", "/llms-full.txt"]);
  assert.deepEqual(copied, [
    await readFile(new URL("guide/index.md", site), "utf8"),
    await readFile(new URL("llms-full.txt", site), "utf8"),
  ]);
});
