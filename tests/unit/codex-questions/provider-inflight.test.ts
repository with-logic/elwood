/** In-flight Codex identities survive same-key redraws without losing native acceptance (PRD §4). */
import { expect, test } from "vitest";
import { reply } from "./acceptance-helpers.ts";
import { harness } from "./adapter-helpers.ts";
import { captured, frame, scriptedIo } from "./helpers.ts";

const color = "ELWOOD_ASYNC_COLOR: Which color?";
const note = "ELWOOD_ASYNC_NOTE: What note?";
const native = (changed = false) => ({
  payload: {
    type: "AgentMessage",
    id: "call",
    delivery: "async",
    questions: [
      { title: changed ? `Changed ${color}` : color, options: ["Amber", "Blue"] },
      { title: changed ? `Changed ${note}` : note },
    ],
  },
});

test.each([
  false,
  true,
])("Codex in-flight same-key metadata cannot replace an owned request (awaitingNative: %s)", async (awaitingNative) => {
  const h = harness();
  h.observe(native());
  h.adapter.render(captured("async-editor-first.txt"));
  const [original, sibling] = h.registry.list();
  const key = h.registry.keyFor(original!.id)!;
  const scripted = scriptedIo(captured("async-editor-first.txt"), [{ input: "\r" }]);
  try {
    await h.adapter.answer(original!, [{ optionIndexes: [0] }], scripted.io);
    if (awaitingNative) {
      scripted.controller.abort();
      h.adapter.render(captured("async-after-first.txt"));
    }
    expect(h.observe(native(true))).toBe(true);
    h.adapter.render(captured("async-badge.txt"));
    h.adapter.render(
      frame(captured("async-editor-first.txt").text.replaceAll(color, `Changed ${color}`)),
    );
    h.adapter.render(
      frame(captured("async-after-first.txt").text.replaceAll(note, `Changed ${note}`)),
    );
    expect(h.registry.find(key)).toBe(original);
    expect(h.registry.get(original!.id)).toBe(original);
    expect(h.registry.get(sibling!.id)).toBeUndefined();
    expect(h.registry.list().map((request) => request.questions[0]?.prompt)).toEqual([
      color,
      `Changed ${note}`,
    ]);
    expect(
      h.events.filter((event) => event.request.id === original!.id).map((event) => event.phase),
    ).toEqual(["raised"]);
    h.adapter.observe(reply(key, "Amber"));
    expect(h.events.at(-1)).toMatchObject({
      phase: "closed",
      reason: "answered",
      request: original,
    });
    expect(h.registry.find(key)).toBeUndefined();
    await expect(
      h.adapter.answer(original!, [{ optionIndexes: [0] }], scripted.io),
    ).rejects.toMatchObject({ code: "question_answer_failed" });
    expect(scripted.writes).toEqual(["\r"]);
  } finally {
    scripted.controller.abort();
    h.registry.shutdown();
  }
});
