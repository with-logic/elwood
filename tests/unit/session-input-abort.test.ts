/** Abort-helper coverage for queued input cancellation (PRD §5.9, C-LOOP-17). */

import { describe, expect, test } from "vitest";
import {
  clearStagedComposer,
  inputAbortError,
  throwIfInputAborted,
  writeUnsafe,
} from "../../src/core/input/abort.ts";

describe("session input abort helpers", () => {
  test("cover absent, typed, raw, and cleanup-failure signals", async () => {
    expect(() => throwIfInputAborted()).not.toThrow();
    const typed = new AbortController();
    typed.abort(new Error("typed"));
    expect(() => throwIfInputAborted(typed.signal)).toThrow("typed");
    const raw = new AbortController();
    raw.abort("raw reason");
    expect(inputAbortError(raw.signal).message).toBe("Submission aborted.");
    await expect(
      clearStagedComposer({ sendInput: () => Promise.reject(new Error("closed")) }),
    ).resolves.toBeUndefined();
  });
});

test("C-API-56 already-cancelled observation holds input without waiting for rendering", async () => {
  const abort = new AbortController();
  abort.abort();
  let observed = false;
  const unsafe = await writeUnsafe(
    {
      sendInput: () => undefined,
      settled: () => {
        observed = true;
        return new Promise<void>(() => {});
      },
    },
    undefined,
    abort.signal,
  );
  expect(unsafe).toBe(true);
  expect(observed).toBe(false);
});
