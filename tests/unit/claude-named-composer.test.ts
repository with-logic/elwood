/** A named Claude session's labelled top rule still fences its composer (C-TRUST-01, C-API-56). */
import { expect, test } from "vitest";
import { claudeEmptyInputFrame } from "../../src/claude/composer/empty-input.ts";
import { claudeTrustClearance, liveClaudeClearance } from "../../src/claude/screen-table.ts";
import { createHeadlessTerminal } from "../../src/terminal/headless.ts";
import { readNativeInputFrame } from "../fixtures/native-input-frame.ts";

const fixture = readNativeInputFrame(
  new URL("../fixtures/claude-2.1.310/named-empty-input.json", import.meta.url),
);
const rows = fixture.text.split("\n");
// The captured rules around the composer, read rather than rebuilt from capture metadata.
const namedTopRule = rows[fixture.cursorY - 1] ?? "";
const plainBottomRule = rows[fixture.cursorY + 1] ?? "";

function edited(change: (lines: string[]) => void): string {
  const lines = [...rows];
  change(lines);
  return lines.join("\n");
}

test("C-TRUST-01 the captured named composer clears trust and reads as empty input", async () => {
  expect(namedTopRule).toMatch(/^─+ Question Asker ─$/);
  expect(plainBottomRule).toMatch(/^─+$/);
  expect([namedTopRule.length, plainBottomRule.length]).toEqual([fixture.cols, fixture.cols]);
  expect(claudeTrustClearance(fixture.text)).toBe(true);
  const terminal = createHeadlessTerminal({ cols: fixture.cols, rows: fixture.rows }, () => {});
  try {
    await terminal.writeOutput(
      `\u001b[2J\u001b[H${fixture.text.replaceAll("\n", "\r\n")}\u001b[${fixture.cursorY + 1};${fixture.cursorX + 1}H\u001b[?25h\u001b]0;${fixture.title}\u0007`,
    );
    expect(terminal.title).toBe("✳ Question Asker");
    expect(claudeEmptyInputFrame(terminal)).toBeDefined();
    expect(liveClaudeClearance(() => terminal)(terminal.snapshot().text)).toBe(true);
  } finally {
    terminal.dispose();
  }
});

test.each([
  [
    "a label without the closing rule cell",
    (lines: string[]) => {
      lines[fixture.cursorY - 1] = namedTopRule.slice(0, -2);
    },
  ],
  [
    "prose above the composer",
    (lines: string[]) => {
      lines[fixture.cursorY - 1] = "Question Asker ─";
    },
  ],
])("C-TRUST-01 rejects %s", async (_name, change) => {
  const text = edited(change);
  expect(claudeTrustClearance(text)).toBe(false);
  const terminal = createHeadlessTerminal({ cols: fixture.cols, rows: fixture.rows }, () => {});
  try {
    await terminal.writeOutput(
      `\u001b[2J\u001b[H${text.replaceAll("\n", "\r\n")}\u001b[${fixture.cursorY + 1};${fixture.cursorX + 1}H\u001b[?25h`,
    );
    expect(claudeEmptyInputFrame(terminal)).toBeUndefined();
  } finally {
    terminal.dispose();
  }
});
