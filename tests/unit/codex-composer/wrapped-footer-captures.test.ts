/** Real Codex 0.170.0 and 0.172.0 footers, read at the width of the terminal that drew them (C-CODEX-26). */
import { expect, test } from "vitest";
import {
  codexComposerClearance,
  codexComposerConfigured,
} from "../../../src/codex/screen/clearance.ts";
import { codexEmptyInputFrame } from "../../../src/codex/screen/empty-input.ts";
import { liveCodexClearance } from "../../../src/codex/screen/live-clearance.ts";
import { CodexRetainedComposerHold } from "../../../src/codex/screen/retained-clearance.ts";
import { codexInputStaged } from "../../../src/codex/screen/staged-input.ts";
import { cachedLiveSnapshot } from "../../../src/terminal/cursor.ts";
import { createHeadlessTerminal } from "../../../src/terminal/headless.ts";
import {
  type CapturedFooter,
  codexFooterCaptures170,
} from "../../fixtures/codex-footer-captures-170.ts";
import { codexPlanModeFooters172 } from "../../fixtures/codex-footer-captures-172.ts";
import { codexTty } from "../../fixtures/trust-composer.ts";

const captures = [...codexFooterCaptures170, ...codexPlanModeFooters172];
const wrapped = captures.filter((capture) => capture.wrapped);
const unwrapped = captures.filter((capture) => !capture.wrapped);
/** Each wrapped capture in its own terminal, and in one four times as wide that cut no row. */
const atWidths = wrapped.flatMap((capture) => [
  { capture, shape: capture.shape, cols: capture.cols, cut: true },
  { capture, shape: capture.shape, cols: capture.cols * 4, cut: false },
]);
/** Readiness evidence and trust clearance for the rows in a terminal `cols` wide. */
const recognized = (rows: readonly string[], cols?: number) => {
  const frame = rows.join("\n");
  return [codexComposerConfigured(frame, cols), codexComposerClearance(frame, { cols })];
};

/** Paint the capture into a terminal `cols` wide; `draft` replaces the placeholder. */
async function painted({ rows }: CapturedFooter, cols: number, draft?: string) {
  const terminal = createHeadlessTerminal({ cols, rows: 12 }, () => undefined);
  const frame = draft === undefined ? rows : [`› ${draft}`, ...rows.slice(1)];
  const cursor = draft === undefined ? "" : `\u001b[1;${draft.length + 3}H`;
  await terminal.writeOutput(`\u001b[2J\u001b[H${codexTty(frame.join("\n"))}${cursor}`);
  return terminal;
}

test("C-CODEX-26 the captures cover wrapped and unwrapped footers", () => {
  expect(wrapped.length).toBeGreaterThan(0);
  expect(unwrapped.length).toBeGreaterThan(0);
});

test.each(captures)("C-CODEX-26 captured at $cols columns: $shape", ({ rows, cols }) => {
  expect(recognized(rows, cols)).toEqual([true, true]);
});

test.each(
  wrapped,
)("C-CODEX-26 rows the width did not cut are not a footer: $cols columns, $shape", ({
  rows,
  cols,
}) => {
  // In a terminal four times as wide, the next word had room beside the row above it.
  expect(recognized(rows, cols * 4)).toEqual([false, false]);
  // Without the terminal's width, no row can be proven cut.
  expect(recognized(rows)).toEqual([false, false]);
});

test.each(unwrapped)("C-CODEX-26 an unwrapped footer needs no width: $cols columns, $shape", ({
  rows,
  cols,
}) => {
  expect(recognized(rows)).toEqual([true, true]);
  expect(recognized(rows, cols * 4)).toEqual([true, true]);
});

test.each(
  atWidths,
)("C-CODEX-26 live readers take the terminal's own width: $cols columns, cut $cut, $shape", async ({
  capture,
  cols,
  cut,
}) => {
  const terminal = await painted(capture, cols);
  const staged = await painted(capture, cols, "draft");
  try {
    expect(liveCodexClearance(() => terminal)(terminal.snapshot().text)).toBe(cut);
    expect(codexEmptyInputFrame(terminal) !== undefined).toBe(cut);
    expect(codexInputStaged(staged, "draft")).toBe(cut);
  } finally {
    terminal.dispose();
    staged.dispose();
  }
});

test.each(
  wrapped,
)("C-CODEX-26 the retained update hold releases at the terminal's width: $cols columns, $shape", async (capture) => {
  const terminal = await painted(capture, capture.cols);
  try {
    const clear = liveCodexClearance(() => terminal);
    const text = terminal.snapshot().text;
    const hold = new CodexRetainedComposerHold(clear, () => cachedLiveSnapshot(terminal));
    expect(hold.observe("Update available! 0.169.0 -> 0.170.0", true)).toBe(true);
    expect(hold.observe(text, false)).toBe(false);
    // A reader that carries no width cannot prove the wrapped composer, so the hold stays.
    const blind = new CodexRetainedComposerHold(clear, () => ({ text, lines: text.split("\n") }));
    expect(blind.observe("Update available! 0.169.0 -> 0.170.0", true)).toBe(true);
    expect(blind.observe(text, false)).toBe(true);
  } finally {
    terminal.dispose();
  }
});

test("C-CODEX-26 stale snapshot width cannot clear the hold for a different frame", () => {
  const { cols, rows } = wrapped[0]!;
  const text = rows.join("\n");
  const hold = new CodexRetainedComposerHold(
    () => true,
    () => ({ text: "old screen", lines: ["old screen"], cols }),
  );
  expect(hold.observe("Update available!", true)).toBe(true);
  expect(hold.observe(text, false)).toBe(true);
});
