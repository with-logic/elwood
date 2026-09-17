/**
 * The non-trust automation write barrier: observe received output, fail closed when it
 * cannot be observed, then veto on the settled frame (PRD §5.3/§5.4, C-API-56, #42).
 */
import { expect, test, vi } from "vitest";
import { guardedAutomationWrite } from "../../src/core/startup/barrier.ts";

const composer = "› \n  (ready)";
const codexTrust =
  "Do you trust the contents of this directory?\n\n› 1. Yes, continue\n  2. No, quit\n\n  Press enter to continue";

test("C-API-56 a write lands once output is observed and the settled frame is clear", async () => {
  const writes: string[] = [];
  const guarded = guardedAutomationWrite(
    { sendInput: () => undefined, settled: () => Promise.resolve(), renderFailed: false },
    (input) => void writes.push(input),
    () => composer,
    "codex",
  );
  await guarded("2");
  expect(writes).toEqual(["2"]);
});

test("C-API-56 a write is withheld when the settled frame shows a trust gate", async () => {
  const writes: string[] = [];
  const guarded = guardedAutomationWrite(
    { sendInput: () => undefined, settled: () => Promise.resolve(), renderFailed: false },
    (input) => void writes.push(input),
    () => codexTrust,
    "codex",
  );
  await guarded("2");
  expect(writes).toEqual([]);
});

test("C-API-56 a failed render fails CLOSED: nothing is written, even on a clear frame", async () => {
  const writes: string[] = [];
  // `renderFailed` is permanent for a terminal: no later output can prove the model
  // complete again, so the frame cannot be vouched for and the key must not go out.
  const guarded = guardedAutomationWrite(
    { sendInput: () => undefined, settled: () => Promise.resolve(), renderFailed: true },
    (input) => void writes.push(input),
    () => composer,
    "codex",
  );
  await guarded("2");
  expect(writes).toEqual([]);
});

test("C-API-56 observation that never completes fails CLOSED once the budget expires", async () => {
  vi.useFakeTimers();
  const writes: string[] = [];
  const guarded = guardedAutomationWrite(
    { sendInput: () => undefined, settled: () => new Promise<void>(() => undefined) },
    (input) => void writes.push(input),
    () => composer,
    "codex",
  );
  const pending = guarded("2");
  await vi.advanceTimersByTimeAsync(2_000); // past the one-second observe budget
  await pending;
  expect(writes).toEqual([]);
  vi.useRealTimers();
});
