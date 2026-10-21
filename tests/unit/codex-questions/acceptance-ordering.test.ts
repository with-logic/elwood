/** Adversarial grouped native answer ordering (PRD §4). */
import { expect, test } from "vitest";
import { output, owned } from "./acceptance-helpers.ts";
import { event } from "./candidate-helpers.ts";

test("checks every modal question and exact note order", () => {
  const { state, candidate, controller, reason } = owned(false);
  state.observe(
    event({
      type: "function_call",
      name: "request_user_input",
      call_id: "call",
      arguments: JSON.stringify({
        questions: [
          { id: "one", question: "First", options: [{ label: "Yes" }] },
          { id: "two", question: "Second", options: [{ label: "No" }] },
        ],
      }),
    }),
  );
  const current = [...state.candidates.values()][0]!;
  expect(current).not.toBe(candidate);
  state.publish(current);
  state.expectAnswer(
    current,
    [{ optionIndexes: [0] }, { optionIndexes: [0], text: "note" }],
    controller.signal,
  );
  state.observe(output({ one: { answers: ["Yes"] }, two: { answers: ["user_note: note", "No"] } }));
  expect(reason()).toMatchObject({ reason: "unavailable" });
});
