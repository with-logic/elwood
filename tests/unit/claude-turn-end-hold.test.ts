/**
 * After a Claude turn ends, queued input waits for a fresh frame that stays unchanged for the
 * settle window and shows the composer with no working indicator or dialog, for a bounded
 * time on a monotonic clock. The limit reports input it releases from a screen without a
 * dialog (C-ATTN-10).
 */
import { afterEach, expect, test, vi } from "vitest";
import {
  ClaudeTurnEndHold,
  turnEndPaintLimitMs,
  turnEndSettleMs,
} from "../../src/claude/session/turn-end-hold.ts";
import { createHeadlessTerminal } from "../../src/terminal/headless.ts";
import { claudeIdle, claudeWorking } from "../fixtures/owned-turn/composer.ts";

const dialog = `${claudeIdle}\r\n Do you want to proceed?\r\n ❯ 1. Yes\r\n   2. No\r\n Esc to cancel`;
const blank = "\x1b[2J\x1b[H";
/** Claude's window title while working, and once idle (C-TURN-05). */
const workingTitle = "\x1b]0;◐ Working\x07";
const idleTitle = "\x1b]0;✳ Claude Code\x07";

afterEach(() => {
  vi.restoreAllMocks();
});

function hold() {
  const terminal = createHeadlessTerminal({ cols: 80, rows: 10 }, () => {});
  const clock = { now: 0 };
  const expired = vi.fn<() => void>();
  const turnEnd = new ClaudeTurnEndHold(
    () => terminal,
    expired,
    () => clock.now,
  );
  return {
    terminal,
    clock,
    turnEnd,
    expired,
    paint: (frame: string) => terminal.writeOutput(frame),
  };
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
  const { terminal, clock, turnEnd, expired, paint } = hold();
  try {
    await paint(claudeWorking);
    turnEnd.arm();
    clock.now = turnEndPaintLimitMs - 1;
    expect(turnEnd.holds()).toBe(true);
    clock.now = turnEndPaintLimitMs;
    expect(turnEnd.holds()).toBe(false);
    // Input waited on a working screen until the limit released it.
    expect(expired).toHaveBeenCalledTimes(1);
    turnEnd.arm();
    expect(turnEnd.holds()).toBe(true);
    expect(turnEnd.release()).toBe(false);
    expect(turnEnd.holds()).toBe(false);
    expect(expired).toHaveBeenCalledTimes(1);
  } finally {
    terminal.dispose();
  }
});

test("C-ATTN-10 the limit reports only input that waited on a screen without a dialog", async () => {
  const { terminal, clock, turnEnd, expired, paint } = hold();
  try {
    // Behind a dialog, its own hold is in charge.
    await paint(dialog);
    turnEnd.arm();
    expect(turnEnd.holds()).toBe(true);
    clock.now = turnEndPaintLimitMs;
    expect(turnEnd.holds()).toBe(false);
    // Nothing read a frame before the limit: nothing waited.
    await paint(claudeWorking);
    turnEnd.arm();
    clock.now = 2 * turnEndPaintLimitMs;
    expect(turnEnd.holds()).toBe(false);
    // A settled frame releases before the limit.
    await paint(claudeIdle);
    turnEnd.arm();
    expect(turnEnd.holds()).toBe(true);
    clock.now += turnEndSettleMs;
    expect(turnEnd.holds()).toBe(false);
    expect(expired).not.toHaveBeenCalled();
  } finally {
    terminal.dispose();
  }
});

test("C-ATTN-10 a working title holds even when the screen shows an idle composer", async () => {
  const { terminal, clock, turnEnd, paint } = hold();
  try {
    await paint(`${workingTitle}${claudeIdle}`);
    turnEnd.arm();
    expect(turnEnd.holds()).toBe(true);
    clock.now = 2 * turnEndSettleMs;
    expect(turnEnd.holds()).toBe(true);
    // The idle title is a change, so the settle window starts again from it.
    await paint(idleTitle);
    expect(turnEnd.holds()).toBe(true);
    clock.now = 3 * turnEndSettleMs - 1;
    expect(turnEnd.holds()).toBe(true);
    clock.now = 3 * turnEndSettleMs;
    expect(turnEnd.holds()).toBe(false);
  } finally {
    terminal.dispose();
  }
});

test("C-ATTN-10 a wall-clock jump neither releases a hold nor stretches it", async () => {
  const terminal = createHeadlessTerminal({ cols: 80, rows: 10 }, () => {});
  try {
    await terminal.writeOutput(claudeIdle);
    const monotonic = vi.spyOn(performance, "now").mockReturnValue(1_000);
    const turnEnd = new ClaudeTurnEndHold(
      () => terminal,
      () => {},
    );
    turnEnd.arm();
    expect(turnEnd.holds()).toBe(true);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 10 * turnEndPaintLimitMs);
    expect(turnEnd.holds()).toBe(true);
    monotonic.mockReturnValue(1_000 + turnEndSettleMs);
    expect(turnEnd.holds()).toBe(false);
  } finally {
    terminal.dispose();
  }
});
