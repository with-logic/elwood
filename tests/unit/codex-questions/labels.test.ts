/** Native queued Other labels disambiguate case-insensitive collisions (PRD §4). */
import { expect, test } from "vitest";
import { queuedOtherLabel } from "../../../src/codex/questions/labels.ts";
import type { QuestionDefinition } from "../../../src/core/questions/types.ts";

const question: QuestionDefinition = {
  prompt: "Choose a test answer",
  options: [],
  selection: "none",
  textMode: "alternative",
  secret: false,
};

test.each([
  { options: [] },
  { options: [{ label: "Another answer" }] },
])("uses the fallback native Other label without an existing collision: $options", ({
  options,
}) => {
  expect(queuedOtherLabel({ ...question, options })).toBe("Other");
});

test.each([
  "Other",
  "other",
  "OTHER",
  "oThEr",
])("disambiguates an existing Other label regardless of case: %s", (label) => {
  expect(queuedOtherLabel({ ...question, options: [{ label }] })).toBe("Other (write an answer)");
});
