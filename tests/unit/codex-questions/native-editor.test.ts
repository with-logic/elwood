/** Measured cursor/style provenance distinguishes identical native editor text (PRD §4). */
import { expect, test } from "vitest";
import { draftMatches } from "../../../src/codex/questions/draft.ts";
import { questionView } from "../../../src/codex/questions/frame.ts";
import type { QuestionDefinition } from "../../../src/core/questions/types.ts";
import { fixture } from "./helpers.ts";
import { nativeFrame } from "./native-frame.ts";

const question: QuestionDefinition = {
  prompt: "ELWOOD_RAW_LITERAL: Enter the literal",
  options: [],
  selection: "none",
  textMode: "alternative",
  secret: false,
};
test.each([
  ["queued", "Type your answer"],
  ["modal", "Add notes"],
])("%s empty placeholder and literal answer have different native evidence", (kind, literal) => {
  const empty = questionView(nativeFrame(`editor/${kind}-literal-empty.json`))!;
  const typed = questionView(nativeFrame(`editor/${kind}-literal-typed.json`))!;
  expect(empty.rawBody).toEqual(typed.rawBody);
  expect(draftMatches(empty, question, "")).toBe(true);
  expect(draftMatches(empty, question, literal)).toBe(false);
  expect(draftMatches(typed, question, "")).toBe(false);
  expect(draftMatches(typed, question, literal)).toBe(true);
  for (const cursor of [
    { ...empty.cursor, visible: false },
    { ...empty.cursor, row: -1 },
    { ...empty.cursor, dimmed: undefined },
    { ...empty.cursor, before: "foreign" },
  ])
    expect(draftMatches({ ...empty, cursor }, question, "")).toBe(false);
  expect(
    draftMatches({ ...typed, cursor: { ...typed.cursor, dimmed: undefined } }, question, literal),
  ).toBe(false);
  expect(draftMatches(typed, question, "different")).toBe(false);
});
test.each([
  "queued",
  "modal",
])("%s clipped/wrapped draft cannot attest full logical text", (kind) => {
  const expected: unknown = JSON.parse(fixture(`editor/${kind}-expected.json`));
  if (
    !(
      expected &&
      typeof expected === "object" &&
      "long" in expected &&
      typeof expected.long === "string"
    )
  )
    throw new Error("Missing measured long editor input");
  for (const width of ["wide", "narrow"]) {
    const view = questionView(nativeFrame(`editor/${kind}-long-typed-${width}.json`));
    if (view)
      expect(
        draftMatches(
          view,
          { ...question, prompt: "ELWOOD_RAW_LONG: Enter the long text" },
          expected.long,
        ),
      ).toBe(false);
    else expect([kind, width]).toEqual(["queued", "narrow"]); // This capture clips its panel heading too.
  }
});
