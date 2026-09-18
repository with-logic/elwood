/**
 * The non-trust automation write barrier: observe received output, fail closed when it
 * cannot be observed, then veto on the settled frame (PRD §5.3/§5.4, C-API-56, #42).
 */
import { expect, test, vi } from "vitest";
import {
  codexOptionStillSafe,
  guardedCodexAutomationWrite,
} from "../../src/codex/update-prompt.ts";
import { guardedNonTrustAutomationWrite } from "../../src/core/startup/barrier.ts";

const composer = "› \n  (ready)";
const codexTrust =
  "Do you trust the contents of this directory?\n\n› 1. Yes, continue\n  2. No, quit\n\n  Press enter to continue";

test("C-API-56 a write lands once output is observed and the settled frame is clear", async () => {
  const writes: string[] = [];
  const guarded = guardedNonTrustAutomationWrite(
    { sendInput: () => undefined, settled: () => Promise.resolve(), renderFailed: false },
    (input: string) => void writes.push(input),
    () => composer,
    "codex",
  );
  expect(await guarded("2")).toBe("written");
  expect(writes).toEqual(["2"]);
});

test("C-API-56 a write is withheld when the settled frame shows a trust gate", async () => {
  const writes: string[] = [];
  const guarded = guardedNonTrustAutomationWrite(
    { sendInput: () => undefined, settled: () => Promise.resolve(), renderFailed: false },
    (input: string) => void writes.push(input),
    () => codexTrust,
    "codex",
  );
  expect(await guarded("2")).toBe("withheld");
  expect(writes).toEqual([]);
});

test("C-API-56 a failed render fails CLOSED: nothing is written, even on a clear frame", async () => {
  const writes: string[] = [];
  // `renderFailed` is permanent for a terminal: no later output can prove the model
  // complete again, so the frame cannot be vouched for and the key must not go out.
  const guarded = guardedNonTrustAutomationWrite(
    { sendInput: () => undefined, settled: () => Promise.resolve(), renderFailed: true },
    (input: string) => void writes.push(input),
    () => composer,
    "codex",
  );
  expect(await guarded("2")).toBe("withheld");
  expect(writes).toEqual([]);
});

test("C-API-56 observation that never completes fails CLOSED once the budget expires", async () => {
  vi.useFakeTimers();
  const writes: string[] = [];
  const guarded = guardedNonTrustAutomationWrite(
    { sendInput: () => undefined, settled: () => new Promise<void>(() => undefined) },
    (input: string) => void writes.push(input),
    () => composer,
    "codex",
  );
  const pending = guarded("2");
  await vi.advanceTimersByTimeAsync(2_000); // past the one-second observe budget
  expect(await pending).toBe("withheld");
  expect(writes).toEqual([]);
  vi.useRealTimers();
});

test("C-CODEX-12 a stale option number is withheld once the settled frame renumbers it", async () => {
  // The key was chosen from a pre-settle frame. A replacement update screen moved the
  // safe choice to 3, so the old "2" now points at a destructive option: withhold it.
  const renumbered =
    "Update available! 0.149.0 -> 0.150.0\n\u203a 1. Update now\n  2. Reset settings\n  3. Skip";
  const writes: string[] = [];
  let frame = "Update available! 0.148.0 -> 0.149.1\n\u203a 1. Update now\n  2. Skip";
  const guarded = guardedNonTrustAutomationWrite(
    {
      sendInput: () => undefined,
      settled: () =>
        new Promise<void>((resolve) => {
          queueMicrotask(() => {
            frame = renumbered;
            resolve();
          });
        }),
      renderFailed: false,
    },
    (input: string) => void writes.push(input),
    () => frame,
    "codex",
    codexOptionStillSafe,
  );
  expect(await guarded("2")).toBe("withheld");
  expect(writes).toEqual([]);
  // The number that IS safe on the settled frame still goes out.
  expect(await guarded("3")).toBe("written");
  expect(writes).toEqual(["3"]);
});

test("C-CODEX-12 revalidation only judges option-number keys, and a cleared frame is stale", () => {
  const skipScreen = "Update available! 0.148.0 -> 0.149.1\n\u203a 1. Update now\n  2. Skip";
  // A non-numeric key (the Claude decline's Escape) is not an option number: untouched.
  expect(codexOptionStillSafe(composer, "\u001b")).toBe(true);
  // Codex may repaint the safe choices WITHOUT the banner; that key is still good.
  expect(codexOptionStillSafe("  2. Skip\n  3. Skip until next version", "2")).toBe(true);
  expect(codexOptionStillSafe(skipScreen, "2")).toBe(true);
  // A frame with no numbered options has moved on entirely: the key is stale.
  expect(codexOptionStillSafe(composer, "2")).toBe(false);
  // A number that now names an UNSAFE option is stale too.
  expect(codexOptionStillSafe(skipScreen, "1")).toBe(false);
});

test("C-CODEX-12 the Codex factory binds revalidation into the barrier", async () => {
  const writes: string[] = [];
  let frame = "Update available! 0.148.0 -> 0.149.1\n\u203a 1. Update now\n  2. Skip";
  const guarded = guardedCodexAutomationWrite(
    { sendInput: () => undefined, settled: () => Promise.resolve(), renderFailed: false },
    (input: string) => void writes.push(input),
    () => frame,
  );
  expect(await guarded("2")).toBe("written");
  frame = composer; // the update screen is gone: a repeat key is stale
  expect(await guarded("2")).toBe("withheld");
  expect(writes).toEqual(["2"]);
});
