/** Bounded Codex question metadata and redraw work (PRD §4). */
import { expect, test } from "vitest";
import { harness } from "./adapter-helpers.ts";
import { captured, records, scriptedIo } from "./helpers.ts";

test("removed registry authority rejects answers without scanning candidates", async () => {
  const h = harness();
  h.observe(records("async-records.json")[1]);
  h.adapter.render(captured("async-badge.txt"));
  const request = h.registry.list()[0]!;
  h.registry.close(request.id, "unavailable");
  const scripted = scriptedIo(undefined, []);
  await expect(h.adapter.answer(request, [], scripted.io)).rejects.toMatchObject({
    code: "question_answer_failed",
  });
  expect(scripted.writes).toEqual([]);
});
