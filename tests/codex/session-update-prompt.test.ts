/**
 * Session-level conformance for the Codex update-prompt guard: no update-skip key and no
 * queued input reach a prompt that contradicts the captured appearance.
 * Covers PRD §5.5, C-CODEX-22 (issue #50) and C-CODEX-12.
 */

import { afterEach, describe, expect, test } from "vitest";
import { startCodex } from "../../src/index.ts";
import { becomeReady, installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

/** The measured real split (#50): the banner frame carries ONLY `1. Update now`. */
const bannerFrame = "Update available! 0.151.0 -> 0.152.0\r\n  1. Update now";
/** An UNRELATED option-only prompt: every option skip-shaped, and it reassigns `1`. */
const replacement = "[2J[H  1. Skip backup\r\n  2. Skip";
const persona = "Never update from the live TUI.";

describe("Codex update-prompt evidence", () => {
  test("C-CODEX-22 an all-skip-shaped unrelated prompt never receives the update-skip key", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startCodex({ cwd, persona });
    try {
      ptys[0]!.emitData(bannerFrame);
      await session.terminal.settled();
      // On its own frame the replacement is shaped exactly like an update continuation;
      // only the captured evidence (`1` was `Update now`) proves it is a different dialog.
      ptys[0]!.emitData(replacement);
      await session.terminal.settled();
      await becomeReady(session.elwoodSessionId, cwd);
      await new Promise((resolve) => setImmediate(resolve));
      // No update-skip digit is written into a prompt Elwood never recognized.
      expect(ptys[0]!.writes.filter((write) => /^\d+$/.test(write))).toEqual([]);
    } finally {
      await session.teardown();
    }
  });

  test("C-CODEX-22 a contradictory replacement keeps holding queued persona input", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startCodex({ cwd, persona });
    try {
      ptys[0]!.emitData(bannerFrame);
      await session.terminal.settled();
      // A prompt Elwood must NOT automate is still a prompt a human owns. Ending the
      // appearance must not release the queued paste and its Enter into it: that would
      // advance an unrelated dialog without consent, exactly as the skip digit would have.
      ptys[0]!.emitData(replacement);
      await session.terminal.settled();
      await becomeReady(session.elwoodSessionId, cwd);
      await new Promise((resolve) => setImmediate(resolve));
      // Neither the skip digit nor the persona paste/Enter reaches the replacement.
      expect(ptys[0]!.writes).toEqual([]);
      // A frame that positively shows no dialog is what releases the hold.
      ptys[0]!.emitData("[2J[H› Explain this codebase\r\n  gpt-5.5 high\x1b[1;3H");
      await session.terminal.settled();
      await expect.poll(() => ptys[0]!.writes.length).toBeGreaterThan(0);
      expect(ptys[0]!.writes).toContain(`[200~${persona}[201~`);
    } finally {
      await session.teardown();
    }
  });
});
