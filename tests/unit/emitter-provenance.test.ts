/** Handler provenance belongs to the selected event registration (PRD §6.4 / C-HRESP-01). */

import { expect, test } from "vitest";
import { TypedEmitter } from "../../src/events/emitter.ts";

test("C-HRESP-01 duplicate and cross-event registration cannot change provenance", async () => {
  const emitter = new TypedEmitter<{ first: string; second: string }>();
  const handler = (value: string) => value;
  emitter.listen("first", handler);
  emitter.listen("first", handler, "tool-keyed");
  emitter.listen("second", handler, "tool-keyed");
  expect(await emitter.requestWithProvenance("first", "one")).toEqual({
    value: "one",
    provenance: "event",
  });
  expect(await emitter.requestWithProvenance("second", "two")).toEqual({
    value: "two",
    provenance: "tool-keyed",
  });
  emitter.off("second", handler);
  emitter.listen("second", handler);
  expect(await emitter.requestWithProvenance("second", "three")).toEqual({
    value: "three",
    provenance: "event",
  });
});
