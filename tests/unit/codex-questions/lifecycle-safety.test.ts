/** Native Codex question lifecycle and guarded answering (PRD §4). */
import { expect, test } from "vitest";
import { harness } from "./adapter-helpers.ts";
import { captured, records, scriptedIo } from "./helpers.ts";

test("queued and modal requests coexist without merging native acceptance units", () => {
  const h = harness();
  const native = records("async-records.json");
  h.observe(native[0]);
  h.observe(native[1]);
  h.adapter.render(captured("async-editor-first.txt"));
  const [color, note] = h.registry.list();
  h.observe(records("blocking-records.json")[0]);
  h.adapter.render(captured("blocking-modal-first.txt"));
  const modal = h.registry.list()[2];
  expect(h.registry.list()).toEqual([color, note, modal]);
  h.observe(native[3]);
  h.adapter.render(captured("async-after-first.txt"));
  expect(h.registry.list()).toEqual([note, modal]);
});
test("disposal after an uncertain Enter releases suppression without further writes", async () => {
  const h = harness();
  const native = records("async-records.json");
  h.observe(native[0]);
  h.observe(native[1]);
  h.adapter.render(captured("async-editor-first.txt"));
  const [color, note] = h.registry.list();
  const scripted = scriptedIo(captured("async-editor-first.txt"), [{ input: "\r" }]);
  let disposed = false;
  await h.adapter.answer(h.registry.list()[0]!, [{ optionIndexes: [0] }], {
    ...scripted.io,
    frame: () => (disposed ? undefined : scripted.io.frame()),
  });
  disposed = true;
  scripted.controller.abort();
  h.adapter.render(captured("async-after-first.txt"));
  expect(h.registry.list()).toEqual([color, note]);
  h.observe(native[3]);
  expect(h.registry.list()).toEqual([note]);
  expect(h.events.at(-1)).toMatchObject({ phase: "closed", reason: "answered", request: color });
  expect(scripted.writes).toEqual(["\r"]);
});
