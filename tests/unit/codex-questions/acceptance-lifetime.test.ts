/** Native candidate transitions release owned expectations (PRD §4). */
import { expect, test, vi } from "vitest";
import { owned, reply } from "./acceptance-helpers.ts";
import { call, event } from "./candidate-helpers.ts";

test.each([
  "close",
  "replace",
  "disable",
  "answered",
])("%s releases the abort listener and candidate values", (transition) => {
  const { state, candidate, controller } = owned();
  const remove = vi.spyOn(controller.signal, "removeEventListener");
  state.expectAnswer(candidate, [{ optionIndexes: [0] }], controller.signal);
  if (transition === "close") state.close(candidate.key, "unavailable");
  if (transition === "replace")
    state.observe(event(call({ id: "call", queued: true, accepted: true, prompt: "Replacement" })));
  if (transition === "disable")
    state.observe(
      event(
        call({ id: "overflow", queued: true, accepted: true, prompt: "x".repeat(1024 * 1024) }),
      ),
    );
  if (transition === "answered") state.observe(reply(candidate.key, "Yes"));
  expect(remove).toHaveBeenCalledOnce();
  expect(() =>
    state.expectAnswer(candidate, [{ optionIndexes: [0] }], controller.signal),
  ).toThrow();
});
