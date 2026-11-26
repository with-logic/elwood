/** Codex 0.172 wraps modal option descriptions in a narrow pane (PRD §5.10, C-QUESTION-04). */
import { expect, test } from "vitest";
import { parseQuestions } from "../../../src/codex/questions/definitions.ts";
import { matchesQuestion, questionView } from "../../../src/codex/questions/frame.ts";
import {
  foldOptionRows,
  nativeSelection,
  readsAsWrapped,
} from "../../../src/codex/questions/selection.ts";
import { withDrawnRows } from "./helpers.ts";
import { nativeFrame } from "./native-frame.ts";

const modalColor = (options: readonly { label: string; description: string }[]) => {
  const [color] =
    parseQuestions(
      [{ id: "color", header: "Color", question: "ELWOOD_MODAL_COLOR: Which color?", options }],
      false,
    ) ?? [];
  if (!color) throw new Error("The modal color question did not parse");
  return color.definition;
};
const color = modalColor([
  { label: "Amber", description: "Warm" },
  { label: "Blue", description: "Cool" },
]);
const frame50 = nativeFrame("modal-footer-wrapped-50.json", "0.172.0");
/** The 50-column capture with `from` replaced by `to`, read the way a live frame is. */
const editFrame = (from: string, to: string) => {
  const lines = frame50.lines.map((row) => row.replace(from, to));
  return questionView({ ...frame50, lines, text: lines.join("\n") })!;
};

// The first of three modal questions. Its third option's description fits on its row at 80
// columns, and wraps onto one more row at 60 and 50 and onto three at 40.
test.each([
  80, 60, 50, 40,
])("C-QUESTION-04 a modal question matches with its descriptions wrapped at %i columns", (cols) => {
  const view = questionView(nativeFrame(`modal-footer-wrapped-${cols}.json`, "0.172.0"));
  expect(view).toMatchObject({ kind: "blocking", count: 3, index: 0, selected: 0 });
  expect(matchesQuestion(view!, color)).toBe(true);
});

test("C-QUESTION-04 the caret on an option whose description wraps selects it", () => {
  const view = editFrame("  › 1. Amber", "    1. Amber");
  const moved = withDrawnRows(
    view,
    view.rawBody.map((row) => row.replace("    3. None of the above", "  › 3. None of the above")),
  );
  expect(nativeSelection(moved.rawBody, false)).toBe(2);
  expect(matchesQuestion(moved, color)).toBe(true);
});

test("C-QUESTION-04 a wrapped description must still read as the option's description", () => {
  // Other words on the continuation row, or the row at another indent, leave it unmatched.
  expect(matchesQuestion(editFrame("details in notes", "details in a note"), color)).toBe(false);
  expect(matchesQuestion(editFrame("    details in notes", "details in notes"), color)).toBe(false);
  // A description shown for an option defined without one does not match either.
  const plain = { ...color, options: color.options.map(({ label }) => ({ label })) };
  expect(matchesQuestion(questionView(frame50)!, plain)).toBe(false);
});

// Codex pads labels to the longest one, "None of the above", so descriptions start at column 26.
const option = (caret: boolean, n: number, label: string, description: string) =>
  `${caret ? "  › " : "    "}${n}. ${label.padEnd(17)}  ${description}`;
const continued = (text: string) => `${" ".repeat(26)}${text}`;

test("C-QUESTION-04 wrapped description rows join the option above them", () => {
  const panel = [
    "  ELWOOD_MODAL_COLOR: Which color?",
    " ",
    option(false, 1, "Two  words", "A warm color that a narrow"),
    continued("pane wraps"),
    option(true, 2, "Blue", "Cool"),
    option(false, 3, "None of the above", "Optionally, add"),
    continued("details in notes (tab)"),
    " ",
  ];
  expect(foldOptionRows(panel)).toEqual([
    panel[0],
    panel[1],
    `${panel[2]}\npane wraps`,
    panel[4],
    `${panel[5]}\ndetails in notes (tab)`,
    panel[7],
  ]);
  // The caret below a wrapped description still selects its option.
  expect(nativeSelection(panel, false)).toBe(1);
});

test("C-QUESTION-04 a description column is measured in display columns", () => {
  // `琥珀` takes four columns but two code units.
  const rows = [
    `    1. 琥珀${" ".repeat(15)}Warm and`,
    continued("bright"),
    option(false, 2, "Blue", "Cool"),
  ];
  expect(foldOptionRows(rows)).toEqual([`${rows[0]}\nbright`, rows[2]]);
});

test.each([
  ["at another indent", [option(false, 1, "Amber", "Warm and"), ` ${continued("bright")}`], 3],
  ["under an option without a description", ["    1. Amber", continued("bright")], 3],
  [
    "that starts like an option number",
    [option(false, 1, "Amber", "Step 1."), continued("2. then restart")],
    2,
  ],
])("C-QUESTION-04 folding a row %s leaves %i rows", (_, rows, count) => {
  expect(foldOptionRows([...rows, option(false, 2, "Blue", "Cool")])).toHaveLength(count);
});

test.each([
  [
    "a space",
    "A warm color that a\nnarrow pane wraps",
    "A warm color that a narrow pane wraps",
    true,
  ],
  [
    "nothing, inside a word",
    "Edit src/codex/\nquestions/frame.ts",
    "Edit src/codex/questions/frame.ts",
    true,
  ],
  ["anything else", "A warm\ncolor", "A warm, bright color", false],
  ["text past the end", "Warm\nand more", "Warm", false],
])("C-QUESTION-04 a row break may stand for %s", (_, shown, text, reads) => {
  expect(readsAsWrapped(shown, text)).toBe(reads);
});

test("C-QUESTION-04 a description wrapped inside a long word matches", () => {
  const path = "Edit src/codex/questions/selection.ts";
  const captured = questionView(frame50)!;
  const view = withDrawnRows(
    captured,
    captured.rawBody.flatMap((row) =>
      row.startsWith("  › 1. Amber")
        ? [option(true, 1, "Amber", "Edit src/codex/"), continued("questions/selection.ts")]
        : [row],
    ),
  );
  const described = modalColor([
    { label: "Amber", description: path },
    { label: "Blue", description: "Cool" },
  ]);
  expect(matchesQuestion(view, described)).toBe(true);
});
