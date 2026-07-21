/**
 * Coverage for the process-wide Codex config mutex (PRD §5.3, C-CODEX-14): the
 * whole snapshot/picker/compare-and-swap transaction is serialized so two
 * concurrent setModel switches cannot interleave on the shared config.toml, and
 * one caller's rejection does not wedge the next.
 */

import { describe, expect, test } from "vitest";
import { withCodexConfigLock } from "../../src/codex/config-lock.ts";

describe("withCodexConfigLock (C-CODEX-14)", () => {
  test("C-CODEX-14 serializes overlapping transactions (no interleave)", async () => {
    const events: string[] = [];
    const task = (id: string) => async () => {
      events.push(`${id}:start`);
      await new Promise((r) => setTimeout(r, 5));
      events.push(`${id}:end`);
    };
    const a = withCodexConfigLock(task("A"));
    const b = withCodexConfigLock(task("B"));
    await Promise.all([a, b]);
    expect(events).toEqual(["A:start", "A:end", "B:start", "B:end"]);
  });

  test("C-CODEX-14 a rejecting holder still releases the lock for the next caller", async () => {
    const first = withCodexConfigLock(() => Promise.reject(new Error("boom")));
    await expect(first).rejects.toThrow(/boom/);
    await expect(withCodexConfigLock(() => Promise.resolve("ok"))).resolves.toBe("ok");
  });

  test("C-CODEX-14 returns the task's own result to its caller", async () => {
    await expect(withCodexConfigLock(() => Promise.resolve(42))).resolves.toBe(42);
  });
});
