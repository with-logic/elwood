/** Claude's captured auto-mode setup offer is a blocking dialog (PRD §5.3, C-ATTN-09). */
import { expect, onTestFinished, test, vi } from "vitest";
import {
  isClaudeAutoModeOffer,
  isClaudeAutoModeOfferMenu,
} from "../../src/claude/auto-mode/offer.ts";
import { claudeScreenFactTable } from "../../src/claude/screen-table.ts";
import { readScreenFacts } from "../../src/core/screen-facts.ts";
import { capturedFrame } from "../helpers/captured-frames.ts";

const offer = capturedFrame("claude-2.1.332/auto-mode-offer");
const setupStep = capturedFrame("claude-2.1.332/auto-mode-setup-step");
const rule = "─".repeat(40);
const composer = `${rule}\n❯ \n${rule}\n  ⏵⏵ auto mode on (shift+tab to cycle)`;

function blockingIds(text: string): readonly string[] {
  return readScreenFacts(claudeScreenFactTable, { text, title: "✳ Probe Offer" })
    .matched.filter((match) => match.fact === "blocking_prompt_visible")
    .map((match) => match.id);
}

test("C-ATTN-09 the captured offer blocks although its composer stays visible", () => {
  const reading = readScreenFacts(claudeScreenFactTable, { text: offer, title: "✳ Probe Offer" });
  expect(reading.facts.composer_visible).toBe(true);
  expect(reading.facts.blocking_prompt_visible).toBe(true);
  expect(blockingIds(offer)).toEqual(["claude-auto-mode-offer"]);
});

test("C-ATTN-09 the captured setup step, which replaces the composer, also blocks", () => {
  expect(setupStep).toContain("Space to toggle · Esc to cancel");
  expect(blockingIds(setupStep)).toEqual(["claude-auto-mode-offer"]);
});

test("C-ATTN-09 the composer left after the offer closes does not block", () => {
  // Esc removes the offer's rows, from its rule through its hint row, and nothing else.
  const lines = offer.split("\n");
  const title = lines.findIndex((line) => line.includes("Teach auto mode"));
  const hint = lines.findIndex((line) => line.trim() === "Enter to confirm · Esc to cancel");
  const closed = [...lines.slice(0, title - 1), ...lines.slice(hint + 1)].join("\n");
  expect(closed).not.toContain("Teach auto mode");
  expect(closed).toMatch(/^❯\s*$/m);
  expect(blockingIds(closed)).toEqual([]);
});

/** A reply quoting the offer, rule included: the quote is indented like all reply text. */
const quote = [
  "⏺ Claude Code showed this dialog:",
  "",
  `  ${rule}`,
  "  Teach auto mode about your environment?",
  "  ❯ 1. Yes",
  "  Enter to confirm · Esc to cancel",
  "",
].join("\n");

test("C-ATTN-09 a model reply that quotes the offer is not blocking evidence", () => {
  const quoted = `${quote}\n${composer}`;
  expect(isClaudeAutoModeOffer(quoted)).toBe(false);
  expect(blockingIds(quoted)).toEqual([]);
});

test("C-ATTN-09 a quote earlier in the transcript does not hide the live offer", () => {
  const quotedAbove = `${quote}\n${offer}`;
  expect(isClaudeAutoModeOffer(quotedAbove)).toBe(true);
  expect(blockingIds(quotedAbove)).toEqual(["claude-auto-mode-offer"]);
});

test.each([
  ["a title on the first row", "  Teach auto mode about your environment?\n  Esc to cancel"],
  [
    "a title with no hint row yet",
    `${rule}\n  Teach auto mode about your environment?\n  ❯ 1. Yes`,
  ],
  [
    "the composer fence before any hint",
    `${rule}\n  Teach auto mode about your environment?\n${composer}\n  Esc to cancel`,
  ],
])("C-ATTN-09 an incomplete offer shape is not recognized: %s", (_name, text) => {
  expect(isClaudeAutoModeOffer(text)).toBe(false);
});

/** Counts `String.prototype.split` calls for the rest of the test. */
function countSplits() {
  const split = vi.spyOn(String.prototype, "split");
  onTestFinished(() => split.mockRestore());
  return split;
}

test("C-ATTN-09 a frame without the offer's title is not split", () => {
  const split = countSplits();
  expect(isClaudeAutoModeOffer(composer)).toBe(false);
  expect(isClaudeAutoModeOfferMenu(composer)).toBe(false);
  expect(split).not.toHaveBeenCalled();
});
