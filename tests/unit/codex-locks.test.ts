/**
 * Coverage for the two process-wide Codex mutexes, which share one contract: the
 * clipboard lock (PRD §5.3, C-API-46) serializes the whole snapshot/set/paste/restore
 * image-attach transaction, and the config lock (§5.3, C-CODEX-14) serializes the
 * whole snapshot/picker/compare-and-swap setModel transaction — so two concurrent
 * callers cannot interleave, and one caller's rejection does not wedge the next.
 */

import { describe, expect, test } from "vitest";
import { withCodexConfigLock } from "../../src/codex/config/lock.ts";
import { withClipboardLock } from "../../src/codex/images/clipboard-lock.ts";

describe.each([
  { name: "withClipboardLock", criterion: "C-API-46", withLock: withClipboardLock },
  { name: "withCodexConfigLock", criterion: "C-CODEX-14", withLock: withCodexConfigLock },
])("$name ($criterion)", ({ criterion, withLock }) => {
  test(`${criterion} serializes overlapping transactions (no interleave)`, async () => {
    const events: string[] = [];
    const task = (id: string) => async () => {
      events.push(`${id}:start`);
      await new Promise((r) => setTimeout(r, 5));
      events.push(`${id}:end`);
    };
    const a = withLock(task("A"));
    const b = withLock(task("B"));
    await Promise.all([a, b]);
    // B cannot start until A has ended.
    expect(events).toEqual(["A:start", "A:end", "B:start", "B:end"]);
  });

  test(`${criterion} a rejecting holder still releases the lock for the next caller`, async () => {
    const first = withLock(() => Promise.reject(new Error("boom")));
    await expect(first).rejects.toThrow(/boom/);
    // The next caller acquires normally despite the prior rejection.
    await expect(withLock(() => Promise.resolve("ok"))).resolves.toBe("ok");
  });

  test(`${criterion} returns the task's own result to its caller`, async () => {
    await expect(withLock(() => Promise.resolve(42))).resolves.toBe(42);
  });
});
