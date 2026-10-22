/** Full queued native values are verified through the production adapter (PRD §4). */
import { expect, test } from "vitest";
import { reply } from "./acceptance-helpers.ts";
import { harness } from "./adapter-helpers.ts";
import { editorFrame } from "./editor-fixtures.ts";
import { captured, frame, scriptedIo } from "./helpers.ts";

test.each(
  ["early", "late"].flatMap((timing) =>
    ["Complete answer", "Wrong answer", "Complete"].map((value) => ({ timing, value })),
  ),
)("production queued answers require the complete committed value $value ($timing)", async ({
  timing,
  value,
}) => {
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
    let answerSettled = false;
    let acknowledgements = 0;
    const acknowledge = () => {
      expect(answerSettled).toBe(timing === "late");
      if (timing === "early") expect(scripted.writes).toEqual([`\x1b[200~${text}\x1b[201~`, "\r"]);
      acknowledgements++;
      h.adapter.observe(reply(key, value));
      expect(h.events.at(-1)).toMatchObject({
        phase: "closed",
        request,
        reason: value === text ? "answered" : "unavailable",
      });
    };
    await expect(
      h.adapter
        .answer(request, [{ optionIndexes: [], text }], {
          ...scripted.io,
          write: async (input, expected, onDispatch) => {
            await scripted.io.write(input, expected, onDispatch);
            if (input === "\r" && timing === "early") acknowledge();
          },
        })
        .finally(() => {
          answerSettled = true;
        }),
    ).resolves.toBeUndefined();
    if (timing === "late") {
      expect(h.registry.get(request.id)).toBe(request);
      acknowledge();
    }
    expect(acknowledgements).toBe(1);
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
