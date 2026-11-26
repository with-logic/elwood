/** Claude 2.1.332 questionnaires in a 60-column pane wrap their footer (PRD §5.10, C-QUESTION-03). */
import { expect, test } from "vitest";
import { claudeQuestionFooterEnd } from "../../../src/claude/questions/footer.ts";
import {
  claudeQuestionCandidate,
  parseClaudeQuestionScreen,
} from "../../../src/claude/questions/screen.ts";
import { definitions, fruits, nativeSnapshot332 as native } from "./helpers.ts";
import { color, note } from "./native-note-helpers.ts";

const features = definitions[1]!;
/** Both checkbox panels end on a `Submit` tab. */
const submitTab = { questionIndex: 0, hasSubmitTab: true };

test.each([
  [
    "narrow-grouped-next-native",
    [features, color],
    { ...submitTab, cursor: 3, checked: [true, true, false] },
  ],
  [
    "narrow-single-other-placeholder-native",
    [note],
    { questionIndex: 0, hasSubmitTab: false, cursor: 2, other: "Type something." },
  ],
  [
    "narrow-standalone-checkbox-submit-native",
    [fruits],
    { ...submitTab, cursor: 4, checked: [true, false, true, false] },
  ],
] as const)("C-QUESTION-03 reads %s with its footer wrapped over two rows", (name, questions, parsed) => {
  const frame = native(name);
  const rows = frame.lines.filter((line) => line.trim());
  expect(rows.at(-2)).toMatch(/^Enter to select · /);
  expect(rows.at(-1)).toMatch(/Esc to cancel$/);
  expect(claudeQuestionCandidate(frame.text)).toBe(true);
  // Only a composer after the wrapped footer's end retires the panel.
  expect(claudeQuestionCandidate(`${frame.text}\n❯ `)).toBe(false);
  expect(parseClaudeQuestionScreen(frame, questions)).toMatchObject({
    kind: "question",
    ...parsed,
  });
});

const footer = ["Enter to select · ↑/↓ to navigate ·", "ctrl+g to edit in Nvim ·", "Esc to cancel"];
test.each([
  ["one row", [footer.join(" ")], 0],
  ["three rows", ["copy", ...footer], 3],
])("C-QUESTION-03 reads a footer drawn over %s", (_, lines, end) => {
  expect(claudeQuestionFooterEnd(lines)).toBe(end);
});

test.each([
  ["four rows", ["Enter to select ·", "↑/↓ to navigate ·", ...footer.slice(1)]],
  ["rows without the footer's start", ["copy", "Esc to cancel"]],
  ["a row that ends otherwise", ["Enter to select · Esc to cancel now"]],
  ["an indented row, as question copy is", [`  ${footer.join(" ")}`]],
  ["a wrapped footer with an indented row", [footer[0]!, `  ${footer[1]!}`, footer[2]!]],
])("C-QUESTION-03 finds no footer in %s", (_, lines) => {
  expect(claudeQuestionFooterEnd(lines)).toBe(-1);
});
