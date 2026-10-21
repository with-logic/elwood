/** Native semantic replacement invalidates prior public answer authority (PRD §4). */
import { expect, test } from "vitest";
import { payloadOf } from "../../../src/codex/questions/records.ts";
import { isRecord } from "../../../src/core/predicates.ts";
import { harness } from "./adapter-helpers.ts";
import { captured, frame, records } from "./helpers.ts";

test("semantic native replacement invalidates old public answer authority", () => {
  const h = harness();
  const native = records("blocking-records.json")[0];
  if (!isRecord(native)) throw new Error("Missing native question envelope");
  const payload = payloadOf(native);
  if (!payload || typeof payload["arguments"] !== "string")
    throw new Error("Missing native question arguments");
  h.observe(native);
  h.adapter.render(captured("blocking-modal-first.txt"));
  const previous = h.registry.list()[0];
  const changed = {
    ...native,
    payload: {
      ...payload,
      arguments: payload["arguments"].replace("Warm", "New description"),
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
