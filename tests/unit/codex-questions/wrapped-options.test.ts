/** Codex 0.172 wraps modal option descriptions in a narrow pane (PRD §5.10, C-QUESTION-04). */
import { expect, test } from "vitest";
import { parseQuestions } from "../../../src/codex/questions/definitions.ts";
import { matchesQuestion, questionView } from "../../../src/codex/questions/frame.ts";
import { foldOptionRows, nativeSelection } from "../../../src/codex/questions/selection.ts";
import { nativeFrame } from "./native-frame.ts";

const [color] = parseQuestions(
  [
    {
      id: "color",
      header: "Color",
      question: "ELWOOD_MODAL_COLOR: Which color?",
      options: [
        { label: "Amber", description: "Warm" },
        { label: "Blue", description: "Cool" },
      ],
    },
  ],
  false,
) ?? [undefined];
if (!color) throw new Error("The modal color question did not parse");

// The first of three modal questions. Its third option's description fits on its row at 80
// columns, and wraps onto one more row at 60 and 50 and onto three at 40.
test.each([
  80, 60, 50, 40,
])("C-QUESTION-04 a modal question matches with its descriptions wrapped at %i columns", (cols) => {
  const view = questionView(nativeFrame(`modal-footer-wrapped-${cols}.json`, "0.172.0"));
  expect(view).toMatchObject({ kind: "blocking", count: 3, index: 0, selected: 0 });
  expect(matchesQuestion(view!, color.definition)).toBe(true);
});

test("C-QUESTION-04 a wrapped description must still read as the option's description", () => {
  const frame = nativeFrame("modal-footer-wrapped-50.json", "0.172.0");
  const reword = (from: string, to: string) => {
    const lines = frame.lines.map((row) => row.replace(from, to));
    return questionView({ ...frame, lines, text: lines.join("\n") })!;
  };
  // Other words on the continuation row, or the row at another indent, leave the option unmatched.
  expect(matchesQuestion(reword("details in notes", "details in a note"), color.definition)).toBe(
    false,
  );
  expect(
    matchesQuestion(reword("    details in notes", "details in notes"), color.definition),
  ).toBe(false);
});

const panel = [
  "  ELWOOD_MODAL_COLOR: Which color?",
  " ",
  "    1. Amber              A warm color that a narrow",
  "                          pane wraps",
  "  › 2. Blue               Cool",
  "    3. None of the above  Optionally, add",
  "                          details in notes (tab)",
];

test("C-QUESTION-04 a wrapped description row belongs to the option above it", () => {
  expect(foldOptionRows(panel)).toEqual([
    "  ELWOOD_MODAL_COLOR: Which color?",
    " ",
    "    1. Amber              A warm color that a narrow pane wraps",
    "  › 2. Blue               Cool",
    "    3. None of the above  Optionally, add details in notes (tab)",
  ]);
  // The caret below a wrapped description still selects its option.
  expect(nativeSelection(panel, false)).toBe(1);
});

test.each([
  ["at another indent", "                       pane wraps"],
  ["that reads as an option", "                          2. Blue"],
])("C-QUESTION-04 a row %s is not a wrapped description", (_, row) => {
  const rows = [panel[2]!, row];
  expect(foldOptionRows(rows)).toEqual(rows);
});

test("C-QUESTION-04 a row under an option without a description is not folded", () => {
  const rows = ["    1. Amber", "       pane wraps"];
  expect(foldOptionRows(rows)).toEqual(rows);
});
