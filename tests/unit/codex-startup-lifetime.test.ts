/** Codex update automation ends with session disposal (PRD §5.5, C-CODEX-12). */
import { setImmediate } from "node:timers/promises";
import { afterEach, expect, test, vi } from "vitest";
import { CodexStartupPromptResponder } from "../../src/codex/startup-prompts.ts";
import { guardedCodexAutomationWrite } from "../../src/codex/update-prompt.ts";
import { emitSettledStartupOutcomes } from "../../src/core/startup/write.ts";
import { createHeadlessTerminal } from "../../src/terminal/headless.ts";

const prompt = "Update available! 0.153.3 -> 0.153.4\n› 1. Update now\n  2. Skip";
afterEach(() => vi.useRealTimers());

test("C-CODEX-12 disposal prevents new attempts", () => {
  const responder = new CodexStartupPromptResponder();
  const write = vi.fn();
  responder.dispose();
  expect(responder.inputBlocking).toBe(false);
  expect(responder.blockedPrompt).toBeUndefined();
  expect(responder.handle(prompt, write).outcomes).toEqual([]);
  expect(write).not.toHaveBeenCalled();
});

test("C-CODEX-12 disposal cancels the retry timer immediately", async () => {
  vi.useFakeTimers();
  const responder = new CodexStartupPromptResponder();
  const write = vi.fn();
  const result = responder.handle(prompt, write, () => prompt);
  await vi.advanceTimersByTimeAsync(0);
  expect(write).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(1);
  responder.dispose();
  expect(vi.getTimerCount()).toBe(0);
  await expect(result.outcomes[0]?.settled).resolves.toBe("cancelled");
  await vi.advanceTimersByTimeAsync(5000);
  expect(write).toHaveBeenCalledTimes(1);
});

test.each([
  "fulfilled",
  "rejected",
])("C-CODEX-12 a %s write after disposal settles quietly", async (completion) => {
  const responder = new CodexStartupPromptResponder();
  const pending = Promise.withResolvers<void>();
  const result = responder.handle(
    prompt,
    () => pending.promise,
    completion === "fulfilled" ? undefined : () => prompt,
  );
  const emit = vi.fn();
  const emitWarnings = vi.fn();
  emitSettledStartupOutcomes({ emit }, "codex", "s1", result.outcomes, { emitWarnings });
  responder.dispose();
  if (completion === "fulfilled") pending.resolve();
  else pending.reject(new Error("closed PTY"));
  await expect(result.outcomes[0]?.settled).resolves.toBe("cancelled");
  await Promise.resolve();
  expect(emit).not.toHaveBeenCalled();
  expect(emitWarnings).not.toHaveBeenCalled();
});

test("C-CODEX-12 disposal cancels a physical key parked on real terminal settlement", async () => {
  const writes: string[] = [];
  const terminal = createHeadlessTerminal({ cols: 100, rows: 20 }, (input) => {
    writes.push(String(input));
  });
  const settling = Promise.withResolvers<void>();
  const responder = new CodexStartupPromptResponder();
  const guarded = guardedCodexAutomationWrite(
    { sendInput: terminal.sendInput, settled: () => settling.promise },
    (input) => terminal.sendInput(input),
    () => prompt,
  );
  const result = responder.handle(
    prompt,
    () => undefined,
    () => prompt,
    guarded,
  );
  try {
    expect(writes).toEqual([]);
    responder.dispose();
    settling.resolve();
    await expect(result.outcomes[0]?.settled).resolves.toBe("cancelled");
    expect(writes).toEqual([]);
  } finally {
    responder.dispose();
    terminal.dispose();
  }
});

test("C-CODEX-12 lifetime signal promptly cancels observation without waiting for render", async () => {
  const responder = new CodexStartupPromptResponder();
  const settling = Promise.withResolvers<void>();
  const write = vi.fn();
  const guarded = guardedCodexAutomationWrite(
    { sendInput: write, settled: () => settling.promise },
    write,
    () => prompt,
    responder.closingSignal,
  );
  let completed = false;
  const pending = guarded("2").then((result) => {
    completed = true;
    return result;
  });
  try {
    responder.dispose();
    await setImmediate();
    expect(completed).toBe(true);
    await expect(pending).resolves.toBe("withheld");
    await expect(guarded("2")).resolves.toBe("withheld");
    expect(write).not.toHaveBeenCalled();
  } finally {
    settling.resolve();
    await pending;
  }
});
