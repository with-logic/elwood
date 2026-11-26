/**
 * Each rendered Claude frame answers its prompts through `answerClaudeFramePrompts`. The
 * auto-mode offer decline's Escapes go out as Elwood's automation, so they never hand the
 * offer to the caller, and an Escape parked on settlement when the session closes is never
 * written (PRD §5.1, C-CLAUDE-22, C-CLAUDE-27).
 */
import { expect, onTestFinished, test, vi } from "vitest";
import { declineKey } from "../../src/claude/auto-mode/appearance.ts";
import { answerClaudeFramePrompts } from "../../src/claude/session/prompt-writers.ts";
import { ClaudeStartupPromptResponder } from "../../src/claude/startup-prompts.ts";
import { onCallerInput, SessionInputOwnership } from "../../src/runtime/session/session-input.ts";
import { createHeadlessTerminal } from "../../src/terminal/headless.ts";
import { offerText } from "../fixtures/offer-frames.ts";
import { tty } from "../fixtures/trust-composer.ts";
import { fakeOfferSpacing } from "../helpers/offer-spacing.ts";

/** A session terminal showing the offer, whose caller input reaches `responder`. */
async function offerSession(responder: ClaudeStartupPromptResponder) {
  const keys: string[] = [];
  const terminal = createHeadlessTerminal({ cols: 140, rows: 40 }, (input) => {
    keys.push(String(input));
  });
  onTestFinished(() => {
    responder.dispose();
    terminal.dispose();
  });
  new SessionInputOwnership(terminal);
  onCallerInput(terminal, () => responder.callerInput());
  await terminal.writeOutput(tty(offerText)); // xterm parses on real timers
  const read = () => terminal.snapshot().text;
  return {
    terminal,
    answer: () => answerClaudeFramePrompts(responder, terminal, read(), read),
    escapes: () => keys.filter((key) => key === declineKey).length,
  };
}

test("C-CLAUDE-27 the per-frame writers send the offer decline's Escapes as automation", async () => {
  const responder = new ClaudeStartupPromptResponder(true);
  const session = await offerSession(responder);
  const spacing = fakeOfferSpacing();
  session.answer();
  await vi.advanceTimersByTimeAsync(spacing * 6);
  // The offer stays up, so the decline spends every Escape it has: caller input would
  // have handed the offer to the human after the first.
  expect(session.escapes()).toBe(4);
});

test("C-CLAUDE-22 an Escape the per-frame writers parked on settlement is withheld at close", async () => {
  const responder = new ClaudeStartupPromptResponder(true);
  const session = await offerSession(responder);
  const spacing = fakeOfferSpacing();
  const settling = Promise.withResolvers<void>();
  const settled = vi.spyOn(session.terminal, "settled").mockReturnValue(settling.promise);
  session.answer();
  await vi.advanceTimersByTimeAsync(spacing);
  expect(settled).toHaveBeenCalledOnce();
  responder.dispose(); // stop(), kill() or PTY exit lands mid-render
  settling.resolve();
  await vi.advanceTimersByTimeAsync(spacing * 6);
  expect(session.escapes()).toBe(0);
});
