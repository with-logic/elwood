/**
 * Claude 2.1.332's empty composer while a turn runs, which only prompt association reads (PRD
 * §5.4, C-API-71). Replays `tests/fixtures/claude-2.1.332/working-composer/`: the composer under
 * the working footer, and under the placeholder Claude shows while guidance is queued.
 */
import { expect, test } from "vitest";
import {
  claudeEmptyInputFrame,
  claudeWorkingEmptyInputFrame,
} from "../../src/claude/composer/empty-input.ts";
import { createHeadlessTerminal } from "../../src/terminal/headless.ts";
import { nativeFrameOutput, readNativeInputFrame } from "../fixtures/native-input-frame.ts";

type Frame = ReturnType<typeof readNativeInputFrame>;
const capture = (name: string): Frame =>
  readNativeInputFrame(
    new URL(`../fixtures/claude-2.1.332/working-composer/${name}.json`, import.meta.url),
  );

/** Both readers on the capture, with its row at `offset` from the composer replaced. */
async function observe(frame: Frame, offset = 0, row?: string) {
  const rows = frame.text.split("\n");
  if (row !== undefined) rows[frame.cursorY + offset] = row;
  const terminal = createHeadlessTerminal({ cols: frame.cols, rows: frame.rows }, () => {});
  try {
    await terminal.writeOutput(nativeFrameOutput({ ...frame, text: rows.join("\n") }));
    return [claudeWorkingEmptyInputFrame(terminal) !== undefined, claudeEmptyInputFrame(terminal)];
  } finally {
    terminal.dispose();
  }
}

test.each([
  "working-empty",
  "queued-messages",
])("C-API-71 the captured %s composer is empty only to prompt association", async (name) => {
  expect(await observe(capture(name))).toEqual([true, undefined]);
});

test.each([
  ["a staged draft", 0, "\u276f unsent text"],
  ["another placeholder", 0, "\u276f\u00a0Press up to edit queued messages now"],
  [
    "an unknown working footer",
    2,
    "  \u23f5\u23f5 bypass permissions on \u00b7 esc to interrupt \u00b7 more",
  ],
  ["a missing bottom rule", 1, ""],
])("C-API-71 a working composer with %s is not empty", async (_label, offset, row) => {
  expect(await observe(capture("queued-messages"), offset, row)).toEqual([false, undefined]);
});

test("C-API-71 the working reader also sees the idle composer", async () => {
  const idle = "  \u23f5\u23f5 bypass permissions on (shift+tab to cycle)";
  const [working, empty] = await observe(capture("working-empty"), 2, idle);
  expect([working, empty !== undefined]).toEqual([true, true]);
});

test("C-API-71 the working reader needs Claude's input cursor", async () => {
  const frame = capture("working-empty");
  expect(await observe({ ...frame, cursorX: 4 })).toEqual([false, undefined]);
});
