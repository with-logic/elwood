/** Captured Codex 0.172 question cells bound the user history above an idle composer (C-ATTN-02). */
import { expect, test } from "vitest";
import { codexComposerRowsClearance } from "../../../src/codex/screen/clearance.ts";
import { liveCodexClearance } from "../../../src/codex/screen/live-clearance.ts";
import { codexScreenFactTableForTrustPolicy } from "../../../src/codex/screen-table.ts";
import { readScreenFacts } from "../../../src/core/screen-facts.ts";
import { createAttentionClearance } from "../../../src/runtime/session/attention-clearance.ts";
import { createHeadlessTerminal } from "../../../src/terminal/headless.ts";
import { nativeFrameOutput } from "../../fixtures/native-input-frame.ts";
import { snapshot } from "../codex-questions/snapshot-fixtures.ts";

// A queued turn that `gpt-6-luna` ended before its last answer: the prompt, the `? ` cells
// Codex 0.172 drew for the questions it asked, the answers, the reply and an idle composer.
const ended = snapshot("turn-ended-question-cells.json", "0.172.0");
// A queued frame of the same prompt from another 0.172 run, with the remaining choice still open.
const queued = snapshot("remaining-color-pending-literal.json", "0.172.0");

/** Paint `capture` into a terminal of its size, with its cursor visible where Codex left it. */
async function painted(capture: typeof ended) {
  const terminal = createHeadlessTerminal({ cols: capture.cols, rows: capture.rows }, () => {});
  await terminal.writeOutput(nativeFrameOutput({ ...capture, title: "", visible: true }));
  return terminal;
}

test("C-ATTN-02 the composer below Codex 0.172 question cells is idle", async () => {
  const geometry = { cursorRow: ended.cursorY, cols: ended.cols };
  expect(codexComposerRowsClearance(ended.lines, geometry)).toBe(true);
  const terminal = await painted(ended);
  try {
    expect(liveCodexClearance(() => terminal)(terminal.snapshot().text)).toBe(true);
  } finally {
    terminal.dispose();
  }
});

test("C-ATTN-02 a queued panel that ends with its turn clears to the idle composer", async () => {
  const table = codexScreenFactTableForTrustPolicy(false);
  const terminal = await painted(ended);
  try {
    const classify = createAttentionClearance(liveCodexClearance(() => terminal));
    const read = (text: string) =>
      classify(readScreenFacts(table, { text, title: "" }), text, false);
    expect(read(queued.text).facts.blocking_prompt_visible).toBe(true);
    const idle = read(terminal.snapshot().text).facts;
    expect([idle.blocking_prompt_visible, idle.composer_visible]).toEqual([false, true]);
  } finally {
    terminal.dispose();
  }
});
