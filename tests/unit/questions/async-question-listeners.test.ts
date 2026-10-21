/** Public question notification delivery never awaits or leaks listener rejections (C-QUESTION-01). */
import { afterEach, expect, test } from "vitest";
import { controllerHarness, disposeTerminals } from "./controller-helpers.ts";
import { definitions } from "./helpers.ts";

afterEach(disposeTerminals);
test.each([
  "question",
  "activity",
] as const)("C-QUESTION-01 %s listeners reject without blocking delivery", async (channel) => {
  const h = controllerHarness();
  const failure = Promise.withResolvers<never>();
  h.events.on(channel, () => failure.promise);
  const delivered: string[] = [];
  h.events.on("question", () => delivered.push("question"));
  h.events.on("activity", (event) => {
    if (event.kind === "question") delivered.push("activity");
  });
  try {
    const request = h.questions.registry.publish("native", "blocking", [definitions[0]!]);
    expect(delivered).toEqual(["question", "activity"]);
    expect(h.questions.list()).toEqual([request]);
    failure.reject(new Error("PRIVATE_LISTENER_FAILURE"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(h.questions.list()).toEqual([request]);
  } finally {
    h.closing.abort();
  }
});
