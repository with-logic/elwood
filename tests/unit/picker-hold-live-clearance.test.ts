/** Foreign picker holds share native render evidence through input views (C-API-55). */
import { readFileSync } from "node:fs";
import { expect, onTestFinished, test, vi } from "vitest";
import { claudeModelComposerClearance } from "../../src/claude/model-composer.ts";
import { claudeModelPicker } from "../../src/claude/model-picker.ts";
import { liveClaudeClearance } from "../../src/claude/screen-table.ts";
import { codexModelPicker } from "../../src/codex/model-picker.ts";
import { liveCodexClearance } from "../../src/codex/screen/live-clearance.ts";
import { clearObservationGapMs } from "../../src/runtime/session/picker-cleanup.ts";
import { PickerHold } from "../../src/runtime/session/picker-hold.ts";
import { PickerInputOwnership } from "../../src/runtime/session/picker-input.ts";
import { createHeadlessTerminal } from "../../src/terminal/headless.ts";
import { claudeTty, codexSmallComposer, codexTty } from "../fixtures/trust-composer.ts";
import { releasesAfterClearStreak } from "../helpers/picker-harness.ts";

const claudeCancelled = readFileSync(
  new URL("../fixtures/claude-2.1.278/model-cancelled.txt", import.meta.url),
  "utf8",
);

test.each([
  "claude",
  "codex",
] as const)("C-API-55 %s holds foreign input until native render evidence clears", async (agent) => {
  // Only the clock is fake: clearance readings count a gap apart, and xterm renders for real.
  vi.useFakeTimers({ toFake: ["Date"] });
  onTestFinished(() => {
    vi.useRealTimers();
  });
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
  const hold = new PickerHold();
  const candidate =
    agent === "claude"
      ? "Select model\n❯ 1. Sonnet  Default"
      : "Select Model and Effort\n› 1. gpt-5.5";
  const idle = agent === "claude" ? claudeTty(claudeCancelled) : codexTty(codexSmallComposer);
  const paint = `\u001b[2J\u001b[H${idle}`;
  const observe = () => hold.observe(terminal.snapshot().text, spec);
  const held = () => {
    for (let read = 0; read < 6; read += 1) {
      expect(observe()).toBe(true);
      vi.advanceTimersByTime(clearObservationGapMs);
    }
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
    expect(releasesAfterClearStreak(observe)).toBe(true);
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
