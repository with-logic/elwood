/**
 * A Codex update skip retypes its key only on a prompt Codex drew after it: Codex drops a
 * key that meets its prompt mid-paint, and a frame unchanged since a key cannot show that
 * Codex ignored it (PRD §5.5, C-CODEX-12, docs/cli-behavior.md "Codex update skip keys").
 */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { CodexStartupPromptResponder } from "../../src/codex/startup-prompts.ts";
import { writeCodexUpdateSkip } from "../../src/codex/update-prompt.ts";
import { codexSmallComposer } from "../fixtures/trust-composer.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

test("C-CODEX-12 retypes a swallowed skip only on a prompt drawn after the key", async () => {
  const responder = new CodexStartupPromptResponder("s1");
  const prompt = "Update available! 0.153.3 -> 0.153.4\n› 1. Update now\n  2. Skip";
  // The first key met a prompt Codex was still painting; it then finished the paint.
  const painted = `${prompt}\n\n  Press enter to continue`;
  let frame = prompt;
  const writes: string[] = [];
  const handled = responder.handle(
    prompt,
    (input) => {
      writes.push(input);
      frame = writes.length === 1 ? painted : "› Ready";
    },
    () => frame,
  );
  const settled = handled.outcomes[0]?.settled;
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
  const results: ("written" | "withheld")[] = ["written", "withheld"];
  const writes: string[] = [];
  const result = writeCodexUpdateSkip(
    "2",
    (input) => {
      writes.push(input);
      frame = writes.length === 1 ? `${prompt}\n` : codexSmallComposer;
      return Promise.resolve(results[writes.length - 1] ?? "written");
    },
    () => frame,
  );
  await vi.runAllTimersAsync();
  await expect(result).resolves.toBe("answered");
  expect(writes).toEqual(["2", "2"]);
});
