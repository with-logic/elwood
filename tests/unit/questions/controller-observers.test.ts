/** Native completion survives public observer failures without stale input holds (PRD §4). */
import { afterEach, expect, test, vi } from "vitest";
import { controllerHarness, disposeControllers } from "./controller-helpers.ts";
import { definitions } from "./helpers.ts";

afterEach(disposeControllers);
test.each([
  false,
  true,
])("a throwing completion observer refreshes held input unless closing=%s", async (closing) => {
  const h = controllerHarness();
  await h.terminal.writeOutput("native composer");
  const request = h.questions.registry.publish("native", "blocking", definitions)!;
  let pending = true;
  let held = true;
  const render = vi.fn(() => {
    held = pending;
  });
  h.questions.configure((registry) => ({
    ...h.adapter,
    blocksInput: () => held,
    observe: () => {
      pending = false;
      registry.close(request.id, "answered");
      return true;
    },
    render,
  }));
  h.events.on("question", (event) => {
    if (event.phase === "closed") {
      if (closing) h.closing.abort();
      throw new Error("consumer");
    }
  });
  expect(h.questions.blocksInput()).toBe(true);
  expect(() => h.activity("completion")).not.toThrow();
  expect(h.questions.list()).toEqual([]);
  expect(render).toHaveBeenCalledTimes(closing ? 0 : 1);
  if (!closing) expect(h.questions.blocksInput()).toBe(false);
  h.closing.abort();
});
