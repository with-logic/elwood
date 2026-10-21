/** Failed adapter preparation abandons private native value expectations (PRD §4). */
import { expect, test } from "vitest";
import { harness } from "./adapter-helpers.ts";
import { captured, records, scriptedIo } from "./helpers.ts";

test("a failed attempt permits a later attempt on the same live question", async () => {
  const h = harness();
  const native = records("async-records.json");
  h.observe(native[0]);
  h.observe(native[1]);
  h.adapter.render(captured("async-editor-first.txt"));
  const request = h.registry.list()[0]!;
  const scripted = scriptedIo(captured("async-editor-blue.txt"), [{ input: "\r" }]);
  await expect(
    h.adapter.answer(request, [{ optionIndexes: [0] }], { ...scripted.io, frame: () => undefined }),
  ).rejects.toMatchObject({ code: "question_answer_failed" });
  await h.adapter.answer(request, [{ optionIndexes: [1] }], scripted.io);
  h.observe(native[3]);
  expect(h.events.at(-1)).toMatchObject({ phase: "closed", reason: "answered" });
  expect(scripted.writes).toEqual(["\r"]);
});
