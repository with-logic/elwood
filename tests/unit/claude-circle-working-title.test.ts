/** Claude 2.1.281 captured working title and composer (PRD §5.3, C-TURN-05, C-TRUST-01). */
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { claudeScreenFactTable } from "../../src/claude/screen-table.ts";
import { readScreenFacts } from "../../src/core/screen-facts.ts";

const text = readFileSync(
  new URL("../fixtures/claude-2.1.281/working.txt", import.meta.url),
  "utf8",
).trimEnd();
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
