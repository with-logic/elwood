/** Captured Codex 0.163.0 Plan footer retains native idle provenance (PRD §5.3/§5.8). */
import { expect, test } from "vitest";
import {
  codexComposerRow,
  codexComposerRowsClearance,
} from "../../../src/codex/screen/clearance.ts";
import { codexEmptyInputRows } from "../../../src/codex/screen/empty-input.ts";
import { liveCodexClearance } from "../../../src/codex/screen/live-clearance.ts";
import { createHeadlessTerminal } from "../../../src/terminal/headless.ts";
import { snapshot } from "../codex-questions/snapshot-fixtures.ts";

const planSnapshot = snapshot("plan-completed.json");
test("C-API-56 C-TRUST-01 native Plan footer proves an empty composer after a question", () => {
  expect(codexEmptyInputRows(planSnapshot.lines, planSnapshot.cursorY)).toBe(true);
  expect(codexComposerRowsClearance(planSnapshot.lines, planSnapshot.cursorY)).toBe(true);
  expect(codexComposerRow(planSnapshot.lines, false)).toBe(planSnapshot.cursorY);
});
test("C-TRUST-01 the Plan footer still requires the current visible native cursor", async () => {
  const terminal = createHeadlessTerminal(
    { cols: planSnapshot.cols, rows: planSnapshot.rows },
    () => undefined,
  );
  const clear = liveCodexClearance(() => terminal);
  try {
    await terminal.writeOutput(
      `${planSnapshot.text.replaceAll("\n", "\r\n")}\x1b[${planSnapshot.cursorY + 1};${planSnapshot.cursorX + 1}H\x1b[?25h`,
    );
    expect(clear(terminal.snapshot().text)).toBe(true);
    await terminal.writeOutput("\x1b[?25l");
    expect(clear(terminal.snapshot().text)).toBe(false);
    await terminal.writeOutput("\x1b[?25h\x1b[41;3H");
    expect(clear(terminal.snapshot().text)).toBe(false);
  } finally {
    terminal.dispose();
  }
});
test.each([
  "Plan mode (tab to cycle)",
  "Plan mode (⇧tab to cycle) unexpected",
  "Another mode (⇧tab to cycle)",
])("C-TRUST-01 unknown footer suffix cannot borrow native Plan clearance: %s", (suffix) => {
  const rows = planSnapshot.lines.map((line) => line.replace("Plan mode (⇧tab to cycle)", suffix));
  expect(codexEmptyInputRows(rows, planSnapshot.cursorY)).toBe(false);
});
test("C-TRUST-01 native Plan footer cannot clear a draft, active work or approval", () => {
  const draft = planSnapshot.lines.map((line) =>
    line.replace("› Ask Codex to do anything", "› unfinished human draft"),
  );
  expect(codexEmptyInputRows(draft, planSnapshot.cursorY)).toBe(false);
  const working = [...planSnapshot.lines];
  working[0] = "◦ Working (2s • esc to interrupt)";
  expect(codexComposerRowsClearance(working, planSnapshot.cursorY)).toBe(false);
  const approval = [...planSnapshot.lines];
  approval[0] = "Would you like to run the following command?";
  expect(codexEmptyInputRows(approval, planSnapshot.cursorY)).toBe(false);
});
