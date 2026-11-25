/** Codex's destination matcher verifies the picker structure across keymaps (C-ATTN-07). */
import { expect, test } from "vitest";
import { isCodexAgentCommandCenter } from "../../src/codex/command-center-frame.ts";

const cols = 100;
const title = "  Agent command center  Group: Status";
const tabs = "   All 10   Needs you 2   Working 3   Ready 4   Inactive 1";
const divider = `  ${"─".repeat(cols - 4)}`;

function matches(lines: readonly string[]): boolean {
  return isCodexAgentCommandCenter({
    cols,
    rows: lines.length,
    cursorX: 0,
    cursorY: 0,
    lines,
    text: lines.join("\n"),
  });
}

test("C-ATTN-07 a command center with unavailable shortcut hints still has native chrome", () => {
  expect(matches([title, tabs, divider, "", "  Error loading tasks"])).toBe(true);
});

test.each([
  ["missing rows", []],
  ["quoted title", [`assistant: ${title}`, tabs, divider]],
  ["missing counts", [title, "", divider]],
  ["incomplete divider", [title, tabs, divider.slice(0, -1)]],
  ["different divider", [title, tabs, divider.replaceAll("─", "-")]],
])("C-ATTN-07 a command center requires its complete native header (%s)", (_name, lines) => {
  expect(matches(lines)).toBe(false);
});
