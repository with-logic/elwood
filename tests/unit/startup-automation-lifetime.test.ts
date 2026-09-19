/**
 * Non-trust startup automation is bound to session disposal: after `dispose()` the
 * Claude browser-tools decline neither writes nor reports (PRD §5.1/§5.4, C-CLAUDE-22).
 */
import { expect, test } from "vitest";
import { ClaudeStartupPromptResponder } from "../../src/claude/startup-prompts.ts";
import type { ElwoodActivityEvent } from "../../src/core/activity/index.ts";
import type { AutomationWriteResult } from "../../src/core/startup/barrier.ts";
import { emitSettledStartupOutcomes } from "../../src/core/startup/write.ts";
import type { ElwoodWarningEvent } from "../../src/core/warnings/index.ts";

const browserPrompt =
  "Claude Code running in a browser?\n❯ 1. Yes, use my browser\n  2. No, keep browser tools off";

/** Collects everything a disposed session must NOT produce. */
function reporter() {
  const activities: ElwoodActivityEvent[] = [];
  const warnings: ElwoodWarningEvent[] = [];
  return {
    activities,
    warnings,
    emitter: { emit: (_name: "activity", event: ElwoodActivityEvent) => activities.push(event) },
    sink: { emitWarnings: (events: readonly ElwoodWarningEvent[]) => warnings.push(...events) },
  };
}

test("C-CLAUDE-22 a disposed responder attempts no browser-tools decline", () => {
  const writes: string[] = [];
  const responder = new ClaudeStartupPromptResponder(true);
  responder.dispose();
  const outcomes = responder.handle(
    browserPrompt,
    () => undefined,
    () => browserPrompt,
    (input: string) => void writes.push(input),
  );
  expect(outcomes).toEqual([]);
  expect(writes).toEqual([]);
});

test("C-CLAUDE-22 a decline in flight when the session closes settles cancelled", async () => {
  let release: ((result: AutomationWriteResult) => void) | undefined;
  const pending = new Promise<AutomationWriteResult>((resolve) => {
    release = resolve;
  });
  const writes: string[] = [];
  const responder = new ClaudeStartupPromptResponder(true);
  const outcomes = responder.handle(
    browserPrompt,
    () => undefined,
    () => browserPrompt,
    (input: string) => {
      writes.push(input);
      return pending;
    },
  );
  expect(writes).toEqual([""]);
  const report = reporter();
  emitSettledStartupOutcomes(report.emitter, "claude", "sess-1", outcomes, report.sink);
  // The PTY is gone before the write resolves — exactly the stop/kill/exit race.
  responder.dispose();
  release?.("written");
  await expect(outcomes[0]?.settled).resolves.toBe("cancelled");
  await Promise.resolve();
  expect(report.activities).toEqual([]);
  expect(report.warnings).toEqual([]);
});

test("C-CLAUDE-22 a decline that REJECTS after disposal reports no write failure", async () => {
  const responder = new ClaudeStartupPromptResponder(true);
  let reject: ((error: Error) => void) | undefined;
  const pending = new Promise<AutomationWriteResult>((_resolve, rejectWrite) => {
    reject = rejectWrite;
  });
  const outcomes = responder.handle(
    browserPrompt,
    () => undefined,
    () => browserPrompt,
    () => pending,
  );
  const report = reporter();
  emitSettledStartupOutcomes(report.emitter, "claude", "sess-1", outcomes, report.sink);
  responder.dispose();
  reject?.(new Error("PTY is gone"));
  await expect(outcomes[0]?.settled).resolves.toBe("cancelled");
  await Promise.resolve();
  // A write rejected because the session ended is not a `startup_prompt_write_failed`.
  expect(report.warnings).toEqual([]);
  expect(report.activities).toEqual([]);
});

test("C-CLAUDE-22 a live session still declines and reports normally", async () => {
  const writes: string[] = [];
  const responder = new ClaudeStartupPromptResponder(true);
  const outcomes = responder.handle(
    browserPrompt,
    () => undefined,
    () => browserPrompt,
    (input: string) => void writes.push(input),
  );
  expect(writes).toEqual([""]);
  await expect(outcomes[0]?.settled).resolves.toBe("answered");
  const report = reporter();
  emitSettledStartupOutcomes(report.emitter, "claude", "sess-1", outcomes, report.sink);
  await Promise.resolve();
  expect(report.activities).toHaveLength(1);
  expect(report.warnings).toEqual([]);
});
