/**
 * Coverage for the process-wide clipboard mutex (PRD §5.3, C-API-46): the whole
 * snapshot/set/paste/restore transaction is serialized so two concurrent Codex
 * attaches cannot interleave, and one caller's rejection does not wedge the next.
 */

import { describe, expect, test } from "vitest";
import { withClipboardLock } from "../../src/codex/clipboard-lock.ts";

describe("withClipboardLock (C-API-46)", () => {
  test("C-API-46 serializes overlapping transactions (no interleave)", async () => {
    const events: string[] = [];
    const task = (id: string) => async () => {
      events.push(`${id}:start`);
      await new Promise((r) => setTimeout(r, 5));
      events.push(`${id}:end`);
    };
    const a = withClipboardLock(task("A"));
    const b = withClipboardLock(task("B"));
    await Promise.all([a, b]);
    // B cannot start until A has ended.
    expect(events).toEqual(["A:start", "A:end", "B:start", "B:end"]);
  });

  test("C-API-46 a rejecting holder still releases the lock for the next caller", async () => {
    const first = withClipboardLock(() => Promise.reject(new Error("boom")));
    await expect(first).rejects.toThrow(/boom/);
    // The next caller acquires normally despite the prior rejection.
    await expect(withClipboardLock(() => Promise.resolve("ok"))).resolves.toBe("ok");
  });

  test("C-API-46 returns the task's own result to its caller", async () => {
    await expect(withClipboardLock(() => Promise.resolve(42))).resolves.toBe(42);
  });
});
