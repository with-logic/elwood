/** Captured Claude question blocking and manual composer clearance (PRD §5.3, C-TRUST-01). */
import { expect, test } from "vitest";
import { claudeScreenFactTable, claudeTrustClearance } from "../../src/claude/screen-table.ts";
import { readScreenFacts } from "../../src/core/screen-facts.ts";
import { fixture, nativeSnapshot } from "./questions/helpers.ts";

const capturedQuestion = fixture("questions").text;
// Crop only the captured fenced composer and manual footer; no version-banner evidence remains.
const manualComposer = nativeSnapshot("accepted-manual-composer").lines.slice(-4).join("\n");

test("a captured Claude 2.1.305 questionnaire sets the table's blocking fact", () => {
  const reading = readScreenFacts(claudeScreenFactTable, { text: capturedQuestion, title: "" });
  expect(reading.facts.blocking_prompt_visible).toBe(true);
  expect(reading.matched).toContainEqual({
    id: "claude-question-dialog",
    fact: "blocking_prompt_visible",
    region: "screen",
  });
});

test("a question prompt beginning with the composer glyph remains blocking through the table", () => {
  const text = capturedQuestion.replace("\nWhich test color?\n", "\n❯ Which test color?\n");
  expect(
    readScreenFacts(claudeScreenFactTable, { text, title: "" }).facts.blocking_prompt_visible,
  ).toBe(true);
});

test.each([
  `${capturedQuestion}\n${manualComposer}`,
  manualComposer.replace("❯ ", "❯ Please explain the options."),
])("quoted question history and ordinary composer text are non-blocking: %#", (text) => {
  expect(
    readScreenFacts(claudeScreenFactTable, { text, title: "" }).facts.blocking_prompt_visible,
  ).toBe(false);
});

test("C-TRUST-01 manual-mode chrome alone clears a captured fenced empty composer", () => {
  expect(manualComposer).not.toContain("Claude Code v");
  expect(claudeTrustClearance(manualComposer)).toBe(true);
  expect(claudeTrustClearance(manualComposer.replace(/\n.*⏸ manual mode on[^\n]*/, ""))).toBe(
    false,
  );
});
