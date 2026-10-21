/** Preserve deep-input budget behavior across supported Node versions (PRD §4). */
import { expect, test } from "vitest";
import { setup } from "./candidate-helpers.ts";
import { event } from "./helpers.ts";

test("bounded deeply nested input follows the runtime serialization capability", () => {
  const h = setup();
  const { state } = h;
  const nestingDepth = 20_000;
  const nested = `${"[".repeat(nestingDepth)}0${"]".repeat(nestingDepth)}`;
  const nestedValue: unknown = JSON.parse(nested);
  state.observe(
    event({
      payload: {
        type: "function_call",
        name: "request_user_input_async",
        call_id: "nested-bounded",
        arguments: `{"questions":[{"title":"Q","unknown":${nested}}]}`,
      },
    }),
  );
  let supportsJsonRoundTrip = true;
  try {
    JSON.stringify(nestedValue);
  } catch {
    supportsJsonRoundTrip = false;
  }
  for (const candidate of state.candidates.values()) state.publish(candidate);
  expect(h.registry.list()).toHaveLength(supportsJsonRoundTrip ? 1 : 0);
});
