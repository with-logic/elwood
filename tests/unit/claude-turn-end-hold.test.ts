/** Queued Claude input after a turn waits for the frame that ends it, for a bounded time (C-ATTN-10). */
import { expect, test } from "vitest";
import { ClaudeTurnEndHold, turnEndPaintLimitMs } from "../../src/claude/session/turn-end-hold.ts";
import { createHeadlessTerminal } from "../../src/terminal/headless.ts";
import { claudeIdle, claudeWorking } from "../fixtures/owned-turn/composer.ts";

test("C-ATTN-10 a turn's end holds only until a frame stops showing it working, up to the limit", async () => {
  const terminal = createHeadlessTerminal({ cols: 80, rows: 10 }, () => {});
  let now = 0;
  const hold = new ClaudeTurnEndHold(
    () => terminal,
    () => now,
  );
  try {
    await terminal.writeOutput(claudeWorking);
    // Working with no reported end is a running turn: Claude queues input for it.
    expect(hold.holds()).toBe(false);
    hold.turnEnded();
    expect(hold.holds()).toBe(true);
    now = turnEndPaintLimitMs - 1;
    expect(hold.holds()).toBe(true);
    // A working indicator that outlives its turn stops holding at the limit, for good.
    now = turnEndPaintLimitMs;
    expect(hold.holds()).toBe(false);
    now = 0;
    expect(hold.holds()).toBe(false);
    // The end frame releases at once, and stays released when work resumes.
    hold.turnEnded();
    await terminal.writeOutput(claudeIdle);
    expect(hold.holds()).toBe(false);
    await terminal.writeOutput(claudeWorking);
    expect(hold.holds()).toBe(false);
  } finally {
    terminal.dispose();
  }
});
