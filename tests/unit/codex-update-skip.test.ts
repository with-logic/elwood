/**
 * Edge-triggered Codex in-TUI update-skip (PRD §5.5, C-CODEX-12): Elwood always
 * skips the interactive update prompt (never selects "Update now"), and the skip
 * re-arms after authoritative native clearance or a fresh first-party banner, so
 * an update prompt after a restart is skipped again instead of trapping the session in a
 * loop. The real update is the preflight `codex update`, not this in-TUI prompt.
 */

import { describe, expect, test } from "vitest";
import { CodexStartupPromptResponder } from "../../src/codex/startup-prompts.ts";

/** A void-returning write callback that records each input into `sink`. */
function writer<T>(sink: T[]): (input: T) => void {
  return (input) => {
    sink.push(input);
  };
}

const updateScreen = "Update available! 0.148.0 -> 0.149.1\n› 1. Update now\n  2. Skip";

describe("Codex in-TUI update-skip is edge-triggered (C-CODEX-12)", () => {
  test("re-skips an update prompt that REAPPEARS after a restart (breaks the loop)", () => {
    // The reported trap: Elwood skips the update screen, Codex restarts, the update
    // did not take, and the SAME update screen returns. The skip must re-fire on the
    // reappearance — not stay latched — so the session is not stuck on the screen.
    const writes: string[] = [];
    const responder = new CodexStartupPromptResponder();
    // A normal composer frame Codex draws while restarting — clears the update screen.
    const composer = "› \n  (ready)";

    responder.handle(updateScreen, writer(writes)); // first appearance → skip
    responder.handle(updateScreen, writer(writes)); // persistent: answered once, not re-stormed
    expect(writes).toEqual(["2"]);

    responder.handle(composer, writer(writes)); // native composer clearance permits a new appearance
    responder.handle(updateScreen, writer(writes)); // reappears after restart → skip AGAIN
    expect(writes).toEqual(["2", "2"]);
  });

  test("a persistent update screen is skipped exactly once (no per-frame re-storm)", () => {
    // Without a clearing frame between appearances, the latch holds: an update screen
    // that simply persists across many frames must be answered once, not every frame.
    const writes: string[] = [];
    const responder = new CodexStartupPromptResponder();
    for (let i = 0; i < 5; i += 1) responder.handle(updateScreen, writer(writes));
    expect(writes).toEqual(["2"]);
  });

  test("ordinary agent output mentioning 'update' does not re-storm a held skip", () => {
    // Ordinary prose retires the appearance but does not authorize another skip.
    // Fresh banner evidence or positive native clearance is needed to rearm it.
    const writes: string[] = [];
    const responder = new CodexStartupPromptResponder();
    responder.handle(updateScreen, writer(writes)); // skip
    responder.handle("Running `npm update` in the workspace…", writer(writes)); // revoked, no option
    expect(writes).toEqual(["2"]); // nothing new written: no skip option on that frame
  });
});
