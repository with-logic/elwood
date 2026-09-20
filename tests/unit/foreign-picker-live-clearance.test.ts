/** Foreign picker holds share native render evidence through input views (C-API-55). */
import { readFileSync } from "node:fs";
import { expect, test, vi } from "vitest";
import { claudeModelComposerClearance } from "../../src/claude/model-composer.ts";
import { claudeModelPicker } from "../../src/claude/model-picker.ts";
import { liveClaudeClearance } from "../../src/claude/screen-table.ts";
import { codexModelPicker } from "../../src/codex/model-picker.ts";
import { liveCodexClearance } from "../../src/codex/screen/live-clearance.ts";
import { ForeignPickerHold } from "../../src/runtime/session/foreign-picker.ts";
import { PickerInputOwnership } from "../../src/runtime/session/picker-input.ts";
import { createHeadlessTerminal } from "../../src/terminal/headless.ts";
import { claudeTty, codexSmallComposer, codexTty } from "../fixtures/trust-composer.ts";

const claudeCancelled = readFileSync(
  new URL("../fixtures/claude-2.1.278/model-cancelled.txt", import.meta.url),
  "utf8",
);

test.each([
  "claude",
  "codex",
] as const)("C-API-55 %s holds foreign input until native render evidence clears", async (agent) => {
  const inner = createHeadlessTerminal({ cols: 200, rows: 60 }, () => undefined);
  const terminal = new PickerInputOwnership(inner).automated;
  const original = agent === "claude" ? claudeModelPicker : codexModelPicker;
  const spec = {
    ...original,
    isClear:
      agent === "claude"
        ? liveClaudeClearance(() => terminal, claudeModelComposerClearance)
        : liveCodexClearance(() => terminal),
  };
  const hold = new ForeignPickerHold();
  const candidate =
    agent === "claude"
      ? "Select model\n❯ 1. Sonnet  Default"
      : "Select Model and Effort\n› 1. gpt-5.5";
  const idle = agent === "claude" ? claudeTty(claudeCancelled) : codexTty(codexSmallComposer);
  const paint = `\u001b[2J\u001b[H${idle}`;
  const held = () => {
    for (let read = 0; read < 6; read += 1)
      expect(hold.observe(terminal.snapshot().text, spec)).toBe(true);
  };
  try {
    expect(hold.observe(candidate, spec)).toBe(true);
    await terminal.writeOutput(`${paint}\u001b[?25l`);
    held();
    await terminal.writeOutput(`${paint}\u001b[?2026h`);
    held();
    await terminal.writeOutput("\u001b[?2026l\u001b]0;⠋ Working\u0007");
    held();
    await terminal.writeOutput(`\u001b]0;idle\u0007${paint}`);
    const pending = terminal.writeOutput("\u001b[?25l");
    held(); // receipt invalidates the previous composer before its bytes render
    await pending;
    held();
    await terminal.writeOutput(paint);
    for (let read = 0; read < 4; read += 1)
      expect(hold.observe(terminal.snapshot().text, spec)).toBe(true);
    expect(hold.observe(terminal.snapshot().text, spec)).toBe(false);
    expect(hold.observe(candidate, spec)).toBe(true);
    vi.spyOn(inner.xterm, "write").mockImplementationOnce(() => {
      throw new Error("render failed");
    });
    await expect(terminal.writeOutput("replacement")).rejects.toThrow("render failed");
    held();
  } finally {
    terminal.dispose();
  }
});
