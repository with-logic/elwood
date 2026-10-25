/** Claude's captured half-circle working titles and composers (PRD §5.3, C-TURN-05, C-TRUST-01). */
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { claudeScreenFactTable } from "../../src/claude/screen-table.ts";
import { readScreenFacts } from "../../src/core/screen-facts.ts";

function fixture(path: string): string {
  return readFileSync(new URL(`../fixtures/${path}`, import.meta.url), "utf8").trimEnd();
}

const text = fixture("claude-2.1.281/working.txt");
const title = "◐ Claude Code";

test("C-TURN-05 the captured half-circle title marks work without an interrupt footer", () => {
  expect(text).toContain("✻ Wandering… (0s)");
  expect(text).not.toContain("esc to interrupt");
  const reading = readScreenFacts(claudeScreenFactTable, { text, title });
  expect(reading.facts.working_visible).toBe(true);
  expect(reading.matched.map((rule) => rule.id)).toContain("claude-working-title");
  expect(
    readScreenFacts(claudeScreenFactTable, { text: `${title}\n❯ `, title: "✳ Claude Code" }).facts
      .working_visible,
  ).toBe(false);
});

test("C-TURN-05 Claude 2.1.310's alternate half-circle title still marks work", () => {
  const working = fixture("claude-2.1.310/working-half-right.txt");
  expect(working).toContain("✢ Nebulizing… (2s)");
  expect(working).not.toContain("esc to interrupt");
  for (const glyph of ["◐", "◑"]) {
    const reading = readScreenFacts(claudeScreenFactTable, {
      text: working,
      title: `${glyph} Slow counting from one to twenty`,
    });
    expect(reading.facts.working_visible).toBe(true);
    expect(reading.matched.map((rule) => rule.id)).toContain("claude-working-title");
  }
  // The same frame under the idle `✳` title shows no work: only the title carries it.
  const idle = readScreenFacts(claudeScreenFactTable, { text: working, title: "✳ Claude Code" });
  expect(idle.facts.working_visible).toBe(false);
});
