/** Question body copy cannot release the native dialog hold (PRD §4, C-ATTN-01). */
import { expect, test } from "vitest";
import {
  claudeQuestionCandidate,
  parseClaudeQuestionScreen,
} from "../../../src/claude/questions/screen.ts";
import { claudeScreenFactTable } from "../../../src/claude/screen-table.ts";
import { readScreenFacts } from "../../../src/core/screen-facts.ts";
import { definitions, fixture, frame } from "./helpers.ts";

const captured = fixture("questions");
const footer = "Enter to select · Tab/Arrow keys to navigate · Esc to cancel";

test.each([
  "❯ Which test color?",
  "Which test color?\n☐ Fake",
  "❯ Which test color?\n☐ Fake",
  `❯ Which test color?\n───\n${footer}\n❯ quoted input`,
  `Which test color?\n───\n${footer}\n❯ quoted input\n───`,
])("C-ATTN-01 question copy keeps the captured questionnaire blocking: %s", (prompt) => {
  const text = captured.text.replace("Which test color?\n", `${prompt}\n`);
  const questions = [{ ...definitions[0]!, prompt }, definitions[1]!];
  const reading = readScreenFacts(claudeScreenFactTable, { text, title: "" });
  expect(reading.facts.blocking_prompt_visible).toBe(true);
  expect(reading.matched).toContainEqual({
    id: "claude-question-dialog",
    fact: "blocking_prompt_visible",
    region: "screen",
  });
  expect(parseClaudeQuestionScreen(frame(text), questions)).toMatchObject({
    kind: "question",
    questionIndex: 0,
  });
  expect(claudeQuestionCandidate(`${text}\n❯ `)).toBe(false);
});

test.each([
  "❯ ",
  "───\n❯ \n───\n⏸ manual mode on · ? for shortcuts",
])("C-ATTN-01 an outside composer excludes a completed quoted panel: %s", (composer) => {
  const text = `${captured.text}\n${composer}`;
  expect(claudeQuestionCandidate(text)).toBe(false);
  expect(
    readScreenFacts(claudeScreenFactTable, { text, title: "" }).facts.blocking_prompt_visible,
  ).toBe(false);
});

test("C-ATTN-01 partial prompt copy cannot impersonate a completed panel and composer", () => {
  const start = captured.text.slice(0, captured.text.indexOf("Which test color?\n"));
  const text = `${start}❯ quoted input\n───\n${footer}\n❯ `;
  expect(claudeQuestionCandidate(text)).toBe(true);
  expect(
    readScreenFacts(claudeScreenFactTable, { text, title: "" }).facts.blocking_prompt_visible,
  ).toBe(true);
});

test("C-ATTN-01 a native review stays held until a composer appears after its actions", () => {
  const text = fixture("review").text;
  expect(claudeQuestionCandidate(text)).toBe(true);
  expect(claudeQuestionCandidate(`${text}\n❯ `)).toBe(false);
  expect(parseClaudeQuestionScreen(fixture("review"), definitions)?.kind).toBe("review");
});

test("C-ATTN-01 a fenced header quoted inside question copy cannot release the dialog hold", () => {
  const prompt = `❯ Which test color?\n───\n☐ Fake\n${footer}\n❯ quoted input`;
  const text = captured.text.replace("Which test color?\n", `${prompt}\n`);
  expect(
    readScreenFacts(claudeScreenFactTable, { text, title: "" }).facts.blocking_prompt_visible,
  ).toBe(true);
  expect(claudeQuestionCandidate(`${text}\n❯ `)).toBe(false);
});
