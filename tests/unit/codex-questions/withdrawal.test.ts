/** Native withdrawal, replacement and uncertain submission edges (PRD §4). */
import { expect, test } from "vitest";
import { harness } from "./adapter-helpers.ts";
import { captured, frame, records } from "./helpers.ts";

test("semantic native replacement invalidates old public answer authority", () => {
  const h = harness();
  const native = records("blocking-records.json")[0] as {
    readonly payload: Record<string, unknown>;
  };
  h.observe(native);
  h.adapter.render(captured("blocking-modal-first.txt"));
  const previous = h.registry.list()[0];
  const changed = {
    ...native,
    payload: {
      ...native.payload,
      arguments: String(native.payload["arguments"]).replace("Warm", "New description"),
    },
  };
  h.observe(changed);
  expect(h.registry.list()).toEqual([]);
  h.adapter.render(captured("blocking-modal-first.txt"));
  expect(h.registry.list()).toEqual([]);
  h.adapter.render(
    frame(captured("blocking-modal-first.txt").text.replace("Warm", "New description")),
  );
  expect(h.registry.list()[0]?.id).not.toBe(previous?.id);
  expect(h.events[1]).toMatchObject({ phase: "closed", reason: "unavailable" });
});
