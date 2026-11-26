/**
 * After a Claude turn ends, queued input waits for a fresh frame that stays unchanged for the
 * settle window and shows the composer with no working indicator or dialog, for a bounded
 * time (C-ATTN-10).
 */
import { expect, test } from "vitest";
import {
  ClaudeTurnEndHold,
  turnEndPaintLimitMs,
  turnEndSettleMs,
} from "../../src/claude/session/turn-end-hold.ts";
import { createHeadlessTerminal } from "../../src/terminal/headless.ts";
import { claudeIdle, claudeWorking } from "../fixtures/owned-turn/composer.ts";

const dialog = `${claudeIdle}\r\n Do you want to proceed?\r\n ❯ 1. Yes\r\n   2. No\r\n Esc to cancel`;
const blank = "\x1b[2J\x1b[H";

function hold() {
  const terminal = createHeadlessTerminal({ cols: 80, rows: 10 }, () => {});
  const clock = { now: 0 };
  const turnEnd = new ClaudeTurnEndHold(
    () => terminal,
    () => clock.now,
  );
  return { terminal, clock, turnEnd, paint: (frame: string) => terminal.writeOutput(frame) };
}

test("C-ATTN-10 only a fresh idle composer frame, unchanged for the settle window, releases", async () => {
  const { terminal, clock, turnEnd, paint } = hold();
  try {
    await paint(claudeIdle);
    // Nothing ended: nothing is held, even on an idle frame.
    expect(turnEnd.holds()).toBe(false);
    turnEnd.arm();
    expect(turnEnd.armed).toBe(true);
    // The idle frame already on screen counts from when the hold first reads it.
    clock.now = 100;
    expect(turnEnd.holds()).toBe(true);
    clock.now = 100 + turnEndSettleMs - 1;
    expect(turnEnd.holds()).toBe(true);
    // A change restarts the window: here, a dialog that paints over the composer.
    await paint(dialog);
    clock.now = 100 + turnEndSettleMs;
    expect(turnEnd.holds()).toBe(true);
    clock.now = 200 + 2 * turnEndSettleMs;
    expect(turnEnd.holds()).toBe(true);
    // Working, and a screen without Claude's composer, never release either.
    await paint(claudeWorking);
    clock.now = 300 + 3 * turnEndSettleMs;
    expect(turnEnd.holds()).toBe(true);
    await paint(blank);
    expect(turnEnd.holds()).toBe(true);
    clock.now = 400 + 4 * turnEndSettleMs;
    expect(turnEnd.holds()).toBe(true);
    await paint(claudeIdle);
    expect(turnEnd.holds()).toBe(true);
    clock.now = 400 + 5 * turnEndSettleMs;
    expect(turnEnd.holds()).toBe(false);
    expect(turnEnd.armed).toBe(false);
    expect(turnEnd.holds()).toBe(false);
  } finally {
    terminal.dispose();
  }
});

test("C-ATTN-10 a hold ends at its limit, or when released", async () => {
  const { terminal, clock, turnEnd, paint } = hold();
  try {
    await paint(claudeWorking);
    turnEnd.arm();
    clock.now = turnEndPaintLimitMs - 1;
    expect(turnEnd.holds()).toBe(true);
    clock.now = turnEndPaintLimitMs;
    expect(turnEnd.holds()).toBe(false);
    turnEnd.arm();
    expect(turnEnd.holds()).toBe(true);
    expect(turnEnd.release()).toBe(false);
    expect(turnEnd.holds()).toBe(false);
  } finally {
    terminal.dispose();
  }
});
