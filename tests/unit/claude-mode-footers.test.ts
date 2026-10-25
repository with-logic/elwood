/**
 * Claude 2.1.310's permission-mode footer proves an idle composer after the version banner has
 * scrolled away, in every mode (C-TRUST-01, C-API-55, C-API-56). Replays the captures in
 * `tests/fixtures/claude-2.1.310/mode-footers/`.
 */
import { expect, test } from "vitest";
import {
  claudeEmptyInputFrame,
  claudeEmptyInputRows,
} from "../../src/claude/composer/empty-input.ts";
import { claudeModelPicker } from "../../src/claude/model-picker.ts";
import { claudeTrustClearance, liveClaudeClearance } from "../../src/claude/screen-table.ts";
import { createHeadlessTerminal, type ElwoodTerminal } from "../../src/terminal/headless.ts";
import { readNativeInputFrame } from "../fixtures/native-input-frame.ts";

type Frame = ReturnType<typeof readNativeInputFrame>;

const capture = (name: string): Frame =>
  readNativeInputFrame(
    new URL(`../fixtures/claude-2.1.310/mode-footers/${name}.json`, import.meta.url),
  );

/** The captured footer of each `--permission-mode`, in the vim and plain layouts. */
const footers = [
  ["bypass-permissions", "⏵⏵ bypass permissions on (shift+tab to cycle)"],
  ["accept-edits", "⏵⏵ accept edits on (shift+tab to cycle)"],
  ["plan", "⏸ plan mode on (shift+tab to cycle)"],
  ["manual", "⏸ manual mode on"],
  ["auto", "⏵⏵ auto mode on (shift+tab to cycle)"],
  ["dont-ask", "⏵⏵ don't ask on (shift+tab to cycle)"],
] as const satisfies readonly (readonly [string, string])[];

const captures = footers.flatMap(([mode, footer]) =>
  (["vim", "plain"] as const).map((layout) => [`${layout}-${mode}`, footer] as const),
);

async function replay<T>(frame: Frame, read: (terminal: ElwoodTerminal) => T): Promise<T> {
  const terminal = createHeadlessTerminal({ cols: frame.cols, rows: frame.rows }, () => {});
  try {
    await terminal.writeOutput(
      `\u001b[2J\u001b[H${frame.text.replaceAll("\n", "\r\n")}\u001b[${frame.cursorY + 1};${frame.cursorX + 1}H\u001b[?25h\u001b]0;${frame.title}\u0007`,
    );
    return read(terminal);
  } finally {
    terminal.dispose();
  }
}

/** The capture with its footer row (directly below the composer's bottom rule) replaced. */
function withFooter(frame: Frame, ...replacement: string[]): string {
  const rows = frame.text.split("\n");
  rows.splice(frame.cursorY + 2, 1, ...replacement);
  return rows.join("\n");
}

test.each(
  captures,
)("C-TRUST-01 C-API-55 the bannerless %s composer is idle", async (name, footer) => {
  const frame = capture(name);
  expect(frame.text).not.toMatch(/Claude Code v/);
  expect(frame.text.split("\n")[frame.cursorY + 2]).toContain(footer);
  expect(claudeTrustClearance(frame.text)).toBe(true);
  expect(claudeModelPicker.isClear(frame.text)).toBe(true);
  const live = await replay(frame, (terminal) => {
    const text = terminal.snapshot().text;
    return [
      liveClaudeClearance(() => terminal)(text),
      liveClaudeClearance(() => terminal, claudeModelPicker.isClear)(text),
      claudeEmptyInputFrame(terminal) !== undefined,
    ];
  });
  expect(live).toEqual([true, true, true]);
});

test("C-API-55 the composer left by a hand-opened /model closed with Escape is idle", async () => {
  // The picker hold's release evidence: `❯ /model` stays above as transcript.
  const frame = capture("vim-bypass-permissions-after-model");
  expect(frame.text).toContain("❯ /model");
  expect(frame.text).not.toMatch(/Claude Code v/);
  expect(claudeModelPicker.isClear(frame.text)).toBe(true);
  const live = await replay(frame, (terminal) => [
    liveClaudeClearance(() => terminal, claudeModelPicker.isClear)(terminal.snapshot().text),
    claudeEmptyInputFrame(terminal) !== undefined,
  ]);
  expect(live).toEqual([true, true]);
});

test.each([
  // Captured with --effort low, medium, xhigh and max (plain layout, manual mode).
  "  ⏸ manual mode on · ? for shortcuts · ← for agents          ○ low · /effort",
  "  ⏸ manual mode on · ? for shortcuts · ← for agents       ◐ medium · /effort",
  "  ⏸ manual mode on · ? for shortcuts · ← for agents        ◉ xhigh · /effort",
  "  ⏸ manual mode on · ? for shortcuts · ← for agents          ◈ max · /effort",
  // Vim normal mode drops `-- INSERT --` after an Escape at the idle composer.
  "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents        0 tokens",
  // Earlier captures: 2.1.278 auto mode and 2.1.305 manual mode.
  "  -- INSERT -- ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents",
  "  ⏸ manual mode on · ? for shortcuts",
])("C-TRUST-01 C-API-56 captured footer row %j clears", (row) => {
  const frame = capture("plain-manual");
  const text = withFooter(frame, row);
  expect([claudeTrustClearance(text), claudeModelPicker.isClear(text)]).toEqual([true, true]);
  expect(claudeEmptyInputRows(text.split("\n"), frame.cursorY)).toBe(true);
});

test("C-API-56 a narrow footer may move its token count and effort onto their own rows", () => {
  // Captured from a vim/verbose manual-mode session resized to 60 columns.
  const frame = capture("vim-manual");
  const rows = withFooter(
    frame,
    "  -- INSERT -- ⏸ manual mode on · ← for agents",
    "                                                  0 tokens",
    "                                          ● high · /effort",
  ).split("\n");
  expect(claudeEmptyInputRows(rows, frame.cursorY)).toBe(true);
  rows[frame.cursorY + 3] = "  0 tokens and a reply";
  expect(claudeEmptyInputRows(rows, frame.cursorY)).toBe(false);
});

test.each([
  // 2.1.310 prints counts in lowercased compact notation (999, 1.0k or 1k, 12.3k, 2.1m).
  "999 tokens",
  "1.0k tokens",
  "1k tokens",
  "12.3k tokens",
  "2.1m tokens",
  // Grouped and uppercase counts stay accepted.
  "1,234 tokens",
  "2.1M tokens",
])("C-TRUST-01 C-API-55 C-API-56 a footer counting %s clears, inline or on its own row", (count) => {
  const frame = capture("vim-bypass-permissions");
  const footer = "  -- INSERT -- ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents";
  for (const text of [
    withFooter(frame, `${footer}        ${count}`),
    withFooter(frame, footer, `                                                  ${count}`),
  ]) {
    expect([
      claudeTrustClearance(text),
      claudeModelPicker.isClear(text),
      claudeEmptyInputRows(text.split("\n"), frame.cursorY),
    ]).toEqual([true, true, true]);
  }
});

test.each([
  ["a working footer", ["  -- INSERT -- ⏵⏵ bypass permissions on · esc to interrupt"]],
  // Captured at 60 columns: Claude truncates the hint, so the row no longer proves the mode.
  ["a truncated footer", ["  -- INSERT -- ⏵⏵ bypass permissions on (shift+tab to"]],
  [
    "a blank row above the footer",
    ["", "  -- INSERT -- ⏵⏵ bypass permissions on (shift+tab to cycle)"],
  ],
  [
    "an overflow row above the footer",
    ["  0 tokens", "  -- INSERT -- ⏵⏵ bypass permissions on (shift+tab to cycle)"],
  ],
  ["an unknown footer", ["  -- INSERT -- ⏵⏵ bypass permissions on (shift+tab to cycle) · new"]],
])("C-TRUST-01 C-API-55 C-API-56 %s does not prove an idle composer", (_name, replacement) => {
  const frame = capture("vim-bypass-permissions");
  const text = withFooter(frame, ...replacement);
  expect([
    claudeTrustClearance(text),
    claudeModelPicker.isClear(text),
    claudeEmptyInputRows(text.split("\n"), frame.cursorY),
  ]).toEqual([false, false, false]);
});

test("C-API-56 the version banner does not excuse a footer separated from the composer", () => {
  const frame = capture("vim-bypass-permissions");
  const footer = "  -- INSERT -- ⏵⏵ bypass permissions on (shift+tab to cycle)";
  const rows = withFooter(frame, "", footer).split("\n");
  // The capture's top row, the banner's last line, becomes its version line.
  rows.splice(0, 1, " ▐▛███▜▌   Claude Code v2.1.310");
  expect(claudeEmptyInputRows(rows, frame.cursorY)).toBe(false);
  rows.splice(frame.cursorY + 2, 2, "", "");
  expect(claudeEmptyInputRows(rows, frame.cursorY)).toBe(true);
  // With no row under the bottom rule, only the banner can prove the composer.
  const fenced = rows.slice(0, frame.cursorY + 2);
  expect(claudeEmptyInputRows(fenced, frame.cursorY)).toBe(true);
  expect(claudeEmptyInputRows(fenced.slice(1), frame.cursorY - 1)).toBe(false);
});

test("C-TRUST-01 a footer quoted above the composer is transcript, not chrome", () => {
  const frame = capture("vim-bypass-permissions");
  const rows = withFooter(frame, "  unknown status").split("\n");
  // The capture's blank rows above the composer become an agent reply quoting the footer.
  rows.splice(
    1,
    2,
    "⏺ Your footer reads:",
    "  -- INSERT -- ⏵⏵ bypass permissions on (shift+tab to cycle)",
  );
  const text = rows.join("\n");
  expect([claudeTrustClearance(text), claudeModelPicker.isClear(text)]).toEqual([false, false]);
});
