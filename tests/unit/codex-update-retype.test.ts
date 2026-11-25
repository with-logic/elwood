/**
 * A Codex update skip retypes its key only on a prompt Codex drew after it: Codex drops a
 * key that meets its prompt mid-paint, and a frame unchanged since a key cannot show that
 * Codex ignored it (PRD §5.5, C-CODEX-12, docs/cli-behavior.md "Codex update skip keys").
 */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { CodexStartupPromptResponder } from "../../src/codex/startup-prompts.ts";
import {
  guardedCodexAutomationWrite,
  writeCodexUpdateSkip,
} from "../../src/codex/update-prompt.ts";
import type { AutomationWriteResult } from "../../src/core/startup/barrier.ts";
import { codexSmallComposer } from "../fixtures/trust-composer.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

test("C-CODEX-12 retypes a swallowed skip only on a prompt Codex drew after the key", async () => {
  const responder = new CodexStartupPromptResponder("s1");
  const prompt = "Update available! 0.153.3 -> 0.153.4\n› 1. Update now\n  2. Skip";
  let frame = prompt;
  const writes: string[] = [];
  const write = (input: string) => {
    writes.push(input);
    if (writes.length === 2) frame = "› Ready";
  };
  const settled = responder.handle(prompt, write, () => frame).outcomes[0]?.settled;
  await vi.advanceTimersByTimeAsync(1_000);
  expect(writes).toEqual(["2"]);
  // The first key met a prompt Codex was still painting; Codex then finished the paint.
  frame = `${prompt}\n\n  Press enter to continue`;
  responder.handle(frame, write, () => frame);
  await vi.runAllTimersAsync();
  await settled;
  expect(writes).toEqual(["2", "2"]);
  responder.dispose();
});

test("C-CODEX-12 a prompt left unchanged by its key gets no second key", async () => {
  const writes: string[] = [];
  const result = writeCodexUpdateSkip(
    "2",
    (input) => {
      writes.push(input);
    },
    () => "Update available! 0.153.3 -> 0.153.4\n  1. Update now\n› 2. Skip",
  );
  const exhaustion = expect(result).resolves.toBe("exhausted");
  await vi.runAllTimersAsync();
  await exhaustion;
  expect(writes).toEqual(["2"]);
});

test("C-CODEX-12 a stale prompt frame never gets a second key", async () => {
  // Codex took the key and drew its composer, but the frame Elwood reads still shows
  // the prompt for 2 s, as when the PTY's output lags. A retype would reach the composer.
  const prompt = "Update available! 0.153.3 -> 0.153.4\n› 1. Update now\n  2. Skip";
  const writes: string[] = [];
  let wroteAt: number | undefined;
  const result = writeCodexUpdateSkip(
    "2",
    (input) => {
      writes.push(input);
      wroteAt ??= Date.now();
    },
    () => (wroteAt !== undefined && Date.now() - wroteAt >= 2_000 ? codexSmallComposer : prompt),
  );
  await vi.runAllTimersAsync();
  await expect(result).resolves.toBe("answered");
  expect(writes).toEqual(["2"]);
});

test("C-CODEX-12 a withheld retype after a key leaves the next frame to decide", async () => {
  const prompt = "Update available! 0.153.3 -> 0.153.4\n› 1. Update now\n  2. Skip";
  let frame = prompt;
  const results: AutomationWriteResult[] = ["written", "withheld"];
  const attempts: string[] = [];
  const writes: string[] = [];
  const result = writeCodexUpdateSkip(
    "2",
    (input) => {
      attempts.push(input);
      frame = attempts.length === 1 ? `${prompt}\n` : codexSmallComposer;
      const written = results[attempts.length - 1] ?? "written";
      if (written === "written") writes.push(input);
      return Promise.resolve(written);
    },
    () => frame,
  );
  await vi.runAllTimersAsync();
  await expect(result).resolves.toBe("answered");
  expect(attempts).toEqual(["2", "2"]);
  expect(writes).toEqual(["2"]);
});

test("C-CODEX-12 the frame a key met, not the one read before it, decides a retype", async () => {
  // The prompt's footer finished painting while the first key waited to go out.
  const prompt = "Update available! 0.153.3 -> 0.153.4\n› 1. Update now\n  2. Skip";
  const painted = `${prompt}\n\n  Press enter to continue`;
  let frame = prompt;
  const writes: string[] = [];
  const write = guardedCodexAutomationWrite(
    {
      sendInput: () => undefined,
      settled: () => {
        frame = painted;
        return Promise.resolve();
      },
      renderFailed: false,
    },
    (input) => void writes.push(input),
    () => frame,
  );
  const result = writeCodexUpdateSkip("2", write, () => frame);
  const exhaustion = expect(result).resolves.toBe("exhausted");
  await vi.runAllTimersAsync();
  await exhaustion;
  expect(writes).toEqual(["2"]);
});
