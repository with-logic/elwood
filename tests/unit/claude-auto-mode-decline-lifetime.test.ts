/**
 * The auto-mode offer decline is bound to session disposal: an Escape parked on render
 * settlement when the session closes is never written, and the decline reports neither
 * activity nor a write-failure warning. A live decline reports the rejected write that
 * ends it (PRD §5.1/§5.4, C-CLAUDE-16, C-CLAUDE-22, C-CLAUDE-27).
 */
import { expect, onTestFinished, test, vi } from "vitest";
import {
  ClaudeStartupPromptResponder,
  guardedClaudeAutomationWrite,
} from "../../src/claude/startup-prompts.ts";
import type { ElwoodActivityEvent } from "../../src/core/activity/index.ts";
import { emitSettledStartupOutcomes } from "../../src/core/startup/write.ts";
import type { ElwoodWarningEvent } from "../../src/core/warnings/index.ts";
import { capturedFrame } from "../helpers/captured-frames.ts";
import { fakeOfferSpacing } from "../helpers/offer-spacing.ts";

const offer = capturedFrame("claude-2.1.332/auto-mode-offer");

test("C-CLAUDE-22 C-CLAUDE-27 an auto-mode Escape parked on settlement at close is never written or reported", async () => {
  vi.useFakeTimers();
  onTestFinished(() => {
    vi.useRealTimers();
  });
  const writes: string[] = [];
  let settlements = 0;
  const settling = Promise.withResolvers<void>();
  const responder = new ClaudeStartupPromptResponder(true);
  const guarded = guardedClaudeAutomationWrite(
    {
      sendInput: (input: string) => void writes.push(input),
      settled: () => {
        settlements += 1;
        return settling.promise;
      },
    },
    (input: string) => void writes.push(input),
    () => offer,
    () => responder.closing,
  );
  const outcomes = responder.handle(
    offer,
    () => undefined,
    () => offer,
    guarded,
    () => offer,
  );
  const activities: ElwoodActivityEvent[] = [];
  const warnings: ElwoodWarningEvent[] = [];
  emitSettledStartupOutcomes(
    { emit: (_name: "activity", event: ElwoodActivityEvent) => activities.push(event) },
    "claude",
    "sess-1",
    outcomes,
    { emitWarnings: (events: readonly ElwoodWarningEvent[]) => warnings.push(...events) },
  );
  // The first Escape waits out the offer's input guard, then parks on render settlement.
  await vi.advanceTimersByTimeAsync(750);
  expect(settlements).toBe(1);
  responder.dispose(); // stop(), kill() or PTY exit lands mid-render
  settling.resolve();
  await vi.advanceTimersByTimeAsync(750 * 4);
  await expect(outcomes[0]?.settled).resolves.toBe("cancelled");
  expect(writes).toEqual([]);
  expect(activities).toEqual([]);
  expect(warnings).toEqual([]);
});

test("C-CLAUDE-16 C-CLAUDE-27 a live decline ended by rejected writes warns once, promising no retry", async () => {
  const fakeSpacingMs = fakeOfferSpacing();
  const responder = new ClaudeStartupPromptResponder(true);
  const rejecting = () => Promise.reject<void>(new Error("pty write failed"));
  const outcomes = responder.handle(
    offer,
    () => undefined,
    () => offer,
    rejecting,
    () => offer,
  );
  const warnings: ElwoodWarningEvent[] = [];
  emitSettledStartupOutcomes({ emit: () => undefined }, "claude", "sess-1", outcomes, {
    emitWarnings: (events: readonly ElwoodWarningEvent[]) => warnings.push(...events),
  });
  await vi.advanceTimersByTimeAsync(fakeSpacingMs * 4);
  await expect(outcomes[0]?.settled).rejects.toThrow("pty write failed");
  await vi.advanceTimersByTimeAsync(0);
  expect(warnings).toEqual([
    expect.objectContaining({
      code: "startup_prompt_write_failed",
      label: "auto_mode_setup",
      message: "Startup prompt auto_mode_setup could not be answered: PTY write was rejected.",
    }),
  ]);
  responder.dispose();
});
