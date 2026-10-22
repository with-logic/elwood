/** Native Codex pulsing work marker preserves question turn ownership (PRD §5.3/§7A.5). */
import { afterEach, expect, test } from "vitest";
import { codexScreenFactTable } from "../../src/codex/screen-table.ts";
import { readScreenFacts } from "../../src/core/screen-facts.ts";
import { startCodex } from "../../src/index.ts";
import { becomeReady, installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);
test("C-TURN-03 pulsing collapsed queued-question work stays running", async () => {
  installFakes();
  const cwd = tempDir();
  const session = await startCodex({ cwd });
  try {
    await becomeReady(session.elwoodSessionId, cwd);
    const paint = (glyph: "•" | "◦") =>
      ptys[0]!.emitData(
        `\x1b[2J\x1b[H${glyph} Working (2s • esc to interrupt)\r\n• Queued follow-up inputs\r\n  ? 1 question\r\n    ⇧← to answer\r\n› Ask Codex to do anything`,
      );
    paint("•");
    await session.terminal.settled();
    expect(session.status).toBe("running");
    paint("◦");
    await session.terminal.settled();
    expect(session.status).toBe("running");
  } finally {
    await session.kill();
  }
});
test.each([
  "◦ Working (0s • esc to interrupt)",
  "◦ Thinking (3m 05s • esc to interrupt)",
  "◦ Running (1h 02m 03s • esc to interrupt) · task",
])("C-TURN-03 recognizes captured native pulse %s", (text) => {
  expect(readScreenFacts(codexScreenFactTable, { text, title: "" }).facts.working_visible).toBe(
    true,
  );
});
