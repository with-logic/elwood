/** Adapter forwards an ordered blocking question batch to the native answer driver (PRD §4). */
import { expect, test } from "vitest";
import { harness } from "./adapter-helpers.ts";
import { notesFrame } from "./editor-fixtures.ts";
import { captured, frame, records, scriptedIo } from "./helpers.ts";

test("blocking adapter answers Blue then Standard through the captured ordered modal panels", async () => {
  const h = harness();
  h.observe(records("blocking-records.json")[0]);
  const first = captured("blocking-modal-first.txt");
  const second = captured("blocking-modal-second.txt");
  h.adapter.render(first);
  expect(h.registry.list()).toHaveLength(1);
  const request = h.registry.list()[0];
  if (!request) throw new Error("Captured blocking questionnaire must publish its request");
  expect(request).toMatchObject({
    delivery: "blocking",
    questions: [
      {
        prompt: "ELWOOD_MODAL_COLOR: Which color?",
        options: [
          { label: "Amber", description: "Warm" },
          { label: "Blue", description: "Cool" },
          { label: "None of the above", description: "Optionally, add details in notes (tab)" },
        ],
      },
      {
        prompt: "ELWOOD_MODAL_NOTE: What note?",
        options: [
          { label: "Standard", description: "Default note" },
          { label: "Short", description: "Brief note" },
          { label: "None of the above", description: "Optionally, add details in notes (tab)" },
        ],
      },
    ],
  });
  const blue = frame(
    first.text.replace("  › 1. Amber", "    1. Amber").replace("    2. Blue", "  › 2. Blue"),
  );
  const scripted = scriptedIo(first, [
    { input: "\x1b[B", next: blue },
    { input: "\t", next: notesFrame(blue) },
    { input: "\r", next: second },
    { input: "\t", next: notesFrame(second) },
    { input: "\r" },
  ]);
  await h.adapter.answer(request, [{ optionIndexes: [1] }, { optionIndexes: [0] }], scripted.io);
  expect(scripted.writes).toEqual(["\x1b[B", "\t", "\r", "\t", "\r"]);
});
