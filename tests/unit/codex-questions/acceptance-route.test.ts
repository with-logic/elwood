/** Full queued native values are verified through the production adapter (PRD §4). */
import { expect, test } from "vitest";
import { reply } from "./acceptance-helpers.ts";
import { harness } from "./adapter-helpers.ts";
import { editorFrame } from "./editor-fixtures.ts";
import { captured, frame, scriptedIo } from "./helpers.ts";

test.each([
  "Complete answer",
  "Wrong answer",
  "Complete",
])("production queued answers require the complete committed value %j", async (value) => {
  const h = harness();
  const initial = editorFrame(captured("async-after-first.txt"), {
    editorLine: "  Type your answer",
    cursorLineBefore: "  ",
    dimmed: true,
  });
  h.observe({
    payload: {
      type: "AgentMessage",
      id: "call",
      delivery: "async",
      questions: [{ title: "ELWOOD_ASYNC_NOTE: What note?" }],
    },
  });
  h.adapter.render(initial);
  const request = h.registry.list()[0]!;
  const key = h.registry.keyFor(request.id)!;
  const text = "Complete answer";
  const typed = editorFrame(frame(initial.text.replace("Type your answer", text)), {
    editorLine: `  ${text}`,
    cursorLineBefore: `  ${text}`,
    dimmed: false,
  });
  const scripted = scriptedIo(initial, [
    { input: `\x1b[200~${text}\x1b[201~`, next: typed },
    { input: "\r" },
  ]);
  try {
    await expect(
      h.adapter.answer(request, [{ optionIndexes: [], text }], {
        ...scripted.io,
        write: () => Promise.reject(new Error("unwritten driver failure")),
      }),
    ).rejects.toThrow("unwritten driver failure");
    expect(scripted.writes).toEqual([]);
    await h.adapter.answer(request, [{ optionIndexes: [], text }], scripted.io);
    expect(h.registry.get(request.id)).toBe(request);
    h.adapter.observe(reply(key, value));
    expect(h.events.at(-1)).toMatchObject({
      phase: "closed",
      request,
      reason: value === text ? "answered" : "unavailable",
    });
    expect(scripted.writes).toEqual([`\x1b[200~${text}\x1b[201~`, "\r"]);
  } finally {
    scripted.controller.abort();
    h.registry.shutdown();
  }
});
