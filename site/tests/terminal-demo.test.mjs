import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { currentHeading, indexPages, searchPages } from "../guide/guide.mjs";
import {
  CHAPTERS,
  createTerminalDemo,
  DURATION,
  demoFrame,
  highlight,
  TIMELINE,
} from "../terminal-demo.mjs";

test("walkthrough can seek through all chapters without losing or inventing code", () => {
  assert.equal(demoFrame(0).text, "");
  for (const step of TIMELINE) {
    const frame = demoFrame(step.end - 0.0001);
    assert.equal(frame.text, step.base + step.text);
    assert.equal(frame.chapter, step.chapter);
  }
  assert.equal(demoFrame(DURATION).done, true);
  assert.match(demoFrame(DURATION).text, /"type": "result"/);
  assert.equal(new Set(TIMELINE.map((step) => step.chapter)).size, CHAPTERS.length);
  assert.match(TIMELINE.find((step) => step.mode?.startsWith("vim")).text, /finally/);
  assert.equal(demoFrame(-5).text, "");
  assert.equal(demoFrame(DURATION + 10).done, true);
  assert.ok(
    TIMELINE.every((step) => !step.text.includes("--agent")),
    "Examples rely on the auto-detected agent",
  );
});

test("syntax highlighting adds color without changing a single character of the transcript", () => {
  const plain = (html) =>
    html
      .replace(/<[^>]+>/g, "")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&");
  for (const step of TIMELINE) {
    const frame = demoFrame(step.end - 0.0001);
    const html = highlight(frame.text, frame.mode);
    assert.equal(plain(html), frame.text);
    for (let i = 1; i < step.text.length; i += 7)
      assert.equal(
        plain(highlight(step.base + step.text.slice(0, i), frame.mode)),
        step.base + step.text.slice(0, i),
      );
  }
  assert.match(
    highlight('$ git diff | elwood "Review"'),
    /tk-cmd">git.*tk-op">\|.*tk-cmd">elwood.*tk-str">"Review"/,
  );
  assert.match(
    highlight('$ elwood --output json \\\n  "Which?"'),
    /tk-flag">--output[\s\S]*\n {2}<span class="tk-str">"Which\?"/,
  );
  assert.match(
    highlight('{\n  "durationMs": 2841,\n  "sessionId": null\n}'),
    /tk-key">"durationMs".*tk-num">2841.*tk-num">null/s,
  );
  assert.doesNotMatch(
    highlight("src/session.ts:42, line 7"),
    /tk-num|tk-punc/,
    "Prose output stays plain",
  );
  assert.match(
    highlight("const s = new ClaudeSession();\n-- INSERT --\n:wq", "vim / ask.mts"),
    /tk-kw">const.*tk-type">ClaudeSession.*tk-vim">-- INSERT --.*tk-ex">:wq/s,
  );
  assert.equal(highlight("a <b> & c"), '<span class="tk-out">a &lt;b&gt; &amp; c</span>');
  assert.match(highlight("# a note"), /^<span class="tk-comment">/);
  assert.match(TIMELINE[2].text, /^\n# Elwood is now driving a full Claude Code session/);
});

test("documentation search finds useful pages, supports multiple terms and handles no matches", async () => {
  const pages = indexPages(
    JSON.parse(await readFile(new URL("../guide/search.json", import.meta.url))),
  );
  assert.equal(searchPages(pages, "sessions")[0].url, "#sessions");
  assert.ok(searchPages(pages, "JSON failure").some((page) => page.url === "#recipes"));
  const headings = [
    { id: "a", top: 0 },
    { id: "b", top: 500 },
    { id: "c", top: 900 },
  ];
  assert.equal(currentHeading(headings, 0).id, "a");
  assert.equal(currentHeading(headings, 420).id, "b");
  assert.equal(currentHeading(headings, 2000).id, "c");
  assert.equal(currentHeading([], 10), null);
  assert.equal(searchPages(pages, "nonsensical123xyz").length, 0);
  assert.equal(searchPages(pages, "").length, 5);
});

function demoHarness(t, reduced = false) {
  const nodes = new Map();
  const frames = new Map();
  const listeners = new Map();
  let serial = 0;
  function element() {
    return {
      textContent: "",
      children: [],
      attributes: {},
      handlers: {},
      value: 0,
      addEventListener(name, fn) {
        this.handlers[name] = fn;
      },
      fire(name) {
        this.handlers[name]?.();
      },
      append(...items) {
        this.children.push(...items);
      },
      setAttribute(name, value) {
        this.attributes[name] = value;
      },
      getAttribute(name) {
        return this.attributes[name] ?? null;
      },
      querySelector(selector) {
        if (!nodes.has(selector)) nodes.set(selector, element());
        return nodes.get(selector);
      },
      showModal() {
        this.open = true;
      },
      close() {
        this.open = false;
        this.fire("close");
      },
      focus() {
        this.focused = true;
      },
    };
  }
  const dialog = element();
  const focus = element();
  const globals = {
    document: {
      querySelector: () => dialog,
      createElement: element,
      activeElement: focus,
      hidden: false,
      addEventListener: (name, fn) => listeners.set(name, fn),
    },
    matchMedia: () => ({ matches: reduced }),
    requestAnimationFrame: (fn) => {
      frames.set(++serial, fn);
      return serial;
    },
    cancelAnimationFrame: (id) => frames.delete(id),
  };
  const previous = Object.fromEntries(
    Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  Object.assign(globalThis, globals);
  t.after(() => {
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  let opened = 0;
  let closed = 0;
  const demo = createTerminalDemo({
    onOpen() {
      opened++;
    },
    onClose() {
      closed++;
    },
  });
  return { demo, dialog, frames, nodes, focus, listeners, counts: () => [opened, closed] };
}

test("walkthrough pauses, resumes after seeking from the end, and stops when hidden or closed", (t) => {
  const h = demoHarness(t);
  h.demo.open();
  h.demo.open();
  assert.deepEqual(h.counts(), [1, 0]);
  assert.equal(h.frames.size, 1);
  const pause = h.nodes.get('[data-demo="pause"]');
  pause.fire("click");
  assert.equal(h.frames.size, 0);
  assert.equal(pause.attributes["data-state"], "play");
  pause.fire("click");
  assert.equal(h.frames.size, 1);
  const range = h.nodes.get(".demo-progress");
  range.value = DURATION;
  range.fire("input");
  assert.equal(h.frames.size, 0);
  assert.equal(pause.attributes["data-state"], "replay");
  assert.equal(pause.attributes["aria-label"], "Replay");
  h.nodes.get(".demo-chapters").children[1].fire("click");
  assert.equal(h.frames.size, 1, "Selecting a chapter after the end restarts playback");
  document.hidden = true;
  h.listeners.get("visibilitychange")();
  assert.equal(h.frames.size, 0);
  document.hidden = false;
  h.listeners.get("visibilitychange")();
  assert.equal(h.frames.size, 1);
  h.nodes.get('[data-demo="close"]').fire("click");
  assert.equal(h.frames.size, 0);
  assert.equal(h.focus.focused, true);
  assert.deepEqual(h.counts(), [1, 1]);
  assert.match(
    h.nodes.get(".demo-output").innerHTML,
    /demo-cursor/,
    "A cursor blinks while the walkthrough is mid-way",
  );
});

test("walkthrough grows out of the hero terminal and shrinks back before closing", async (t) => {
  const h = demoHarness(t);
  const played = [];
  let finished;
  h.dialog.getBoundingClientRect = () => ({ left: 100, top: 100, width: 800, height: 600 });
  h.dialog.animate = (keyframes, options) => {
    played.push({ keyframes, options });
    return {
      finished: new Promise((resolve) => {
        finished = resolve;
      }),
      cancel() {
        this.cancelled = true;
      },
    };
  };
  h.demo.open({ left: 500, top: 50, width: 160, height: 110 });
  assert.equal(played.length, 1);
  assert.match(
    played[0].keyframes[0].transform,
    /translate\(80px, -295px\) scale\(0.2, 0.18333333333333332\)/,
  );
  assert.equal(played[0].keyframes[1].transform, "none");
  h.dialog.handlers.cancel({
    preventDefault() {
      this.prevented = true;
    },
  });
  assert.equal(played.length, 2);
  assert.equal(h.dialog.open, true, "The dialog stays open until the shrink finishes");
  h.dialog.handlers.cancel({ preventDefault() {} });
  assert.equal(played.length, 2, "A second Escape does not restart the shrink");
  finished();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(h.dialog.open, false);
  assert.deepEqual(h.counts(), [1, 1]);
  h.demo.open();
  assert.equal(played.length, 2, "Opening without an origin skips the animation");
  h.dialog.handlers.click({ target: h.dialog });
  assert.equal(h.dialog.open, false);
});

test("reduced-motion walkthrough starts paused and chapter selection reveals a readable command", (t) => {
  const h = demoHarness(t, true);
  h.demo.open();
  assert.equal(h.frames.size, 0);
  h.nodes.get(".demo-chapters").children[1].fire("click");
  assert.match(h.nodes.get(".demo-output").innerHTML.replace(/<[^>]+>/g, ""), /git diff/);
  assert.equal(h.frames.size, 0);
  assert.equal(h.nodes.get('[data-demo="pause"]').attributes["data-state"], "play");
});
