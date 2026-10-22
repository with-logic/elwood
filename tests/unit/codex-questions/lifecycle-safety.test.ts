/** Native Codex question lifecycle and guarded answering (PRD §4). */
import { expect, test } from "vitest";
import { harness } from "./adapter-helpers.ts";
import { captured, emptyComposerFrame, frame, records, scriptedIo } from "./helpers.ts";

test("queued and modal requests coexist without merging native acceptance units", () => {
  const h = harness();
  const native = records("async-records.json");
  h.observe(native[0]);
  h.observe(native[1]);
  h.adapter.render(captured("async-editor-first.txt"));
  h.observe(records("blocking-records.json")[0]);
  h.adapter.render(captured("blocking-modal-first.txt"));
  expect(h.registry.list()).toHaveLength(3);
  h.observe(native[3]);
  h.adapter.render(captured("async-after-first.txt"));
  expect(h.registry.list()).toHaveLength(2);
});
test("disposal after an uncertain Enter releases suppression without further writes", async () => {
  const h = harness();
  const native = records("async-records.json");
  h.observe(native[0]);
  h.observe(native[1]);
  h.adapter.render(captured("async-editor-first.txt"));
  const scripted = scriptedIo(captured("async-editor-first.txt"), [{ input: "\r" }]);
  let disposed = false;
  await h.adapter.answer(h.registry.list()[0]!, [{ optionIndexes: [0] }], {
    ...scripted.io,
    frame: () => (disposed ? undefined : scripted.io.frame()),
  });
  disposed = true;
  scripted.controller.abort();
  h.adapter.render(captured("async-after-first.txt"));
  expect(h.registry.list()).toHaveLength(2);
  h.observe(native[3]);
  expect(h.registry.list()).toHaveLength(1);
  expect(h.events.at(-1)).toMatchObject({ phase: "closed", reason: "answered" });
  expect(scripted.writes).toEqual(["\r"]);
});
test("a live composer before committed answer acknowledgement preserves the submitting request", async () => {
  const h = harness();
  const native = records("async-records.json");
  h.observe(native[0]);
  h.observe(native[1]);
  h.adapter.render(captured("async-badge.txt"));
  h.observe(native[4]); // The other independent native question is already answered.
  const single = frame(captured("async-editor-blue.txt").text.replace("  1 of 2\n", ""));
  h.adapter.render(single);
  const composer = emptyComposerFrame();
  const scripted = scriptedIo(single, [{ input: "\r", next: composer }]);
  await h.adapter.answer(h.registry.list()[0]!, [{ optionIndexes: [1] }], scripted.io);
  h.adapter.render(composer);
  expect(h.registry.list()).toHaveLength(1);
  h.observe(native[3]);
  expect(h.registry.list()).toEqual([]);
  expect(h.events.at(-1)).toMatchObject({ phase: "closed", reason: "answered" });
});
