/**
 * Unit tests for the Codex setModel config transaction (PRD §5.3, C-CODEX-14).
 * Exercises every branch of the snapshot → apply → restore flow: the switch
 * succeeding or rejecting, crossed with restore succeeding or throwing, proving
 * that a late picker rejection still restores and that a restore failure never
 * masks the primary automation error.
 */

import { describe, expect, test } from "vitest";
import { runCodexModelSwitch } from "../../src/codex/config-transaction.ts";

function io(overrides: {
  apply: () => Promise<void>;
  restore?: (snapshot: string | undefined) => void;
  snapshot?: () => string | undefined;
}) {
  const restored: (string | undefined)[] = [];
  const spec = {
    snapshot: overrides.snapshot ?? (() => "SNAP"),
    apply: overrides.apply,
    restore:
      overrides.restore ??
      ((snapshot: string | undefined) => {
        restored.push(snapshot);
      }),
  };
  return { spec, restored };
}

describe("runCodexModelSwitch (C-CODEX-14)", () => {
  test("switch succeeds: restore runs with the snapshot", async () => {
    const { spec, restored } = io({ apply: () => Promise.resolve() });
    await runCodexModelSwitch(spec);
    expect(restored).toEqual(["SNAP"]);
  });

  test("switch rejects: restore STILL runs and the primary error propagates", async () => {
    const primary = new Error("model_automation_failed");
    const { spec, restored } = io({ apply: () => Promise.reject(primary) });
    await expect(runCodexModelSwitch(spec)).rejects.toBe(primary);
    // Restore ran despite the rejection — the user's default is not left changed.
    expect(restored).toEqual(["SNAP"]);
  });

  test("switch succeeds but restore throws: the restore error surfaces", async () => {
    const restoreError = new Error("disk full");
    const { spec } = io({
      apply: () => Promise.resolve(),
      restore: () => {
        throw restoreError;
      },
    });
    await expect(runCodexModelSwitch(spec)).rejects.toBe(restoreError);
  });

  test("switch rejects AND restore throws: PRIMARY preserved, restore failure REPORTED", async () => {
    const primary = new Error("model_automation_failed");
    const restoreError = new Error("restore blew up too");
    const reported: unknown[] = [];
    const { spec } = io({
      apply: () => Promise.reject(primary),
      restore: () => {
        throw restoreError;
      },
    });
    // The restore failure is contained so it never masks the primary error, but it
    // must be REPORTED (not silently dropped) so the user learns config may be dirty.
    await expect(
      runCodexModelSwitch({ ...spec, onRestoreError: (e) => reported.push(e) }),
    ).rejects.toBe(primary);
    expect(reported).toEqual([restoreError]);
  });

  test("switch rejects AND restore throws with NO reporter: still preserves primary", async () => {
    const primary = new Error("model_automation_failed");
    const { spec } = io({
      apply: () => Promise.reject(primary),
      restore: () => {
        throw new Error("restore blew up too");
      },
    });
    // onRestoreError is optional — its absence must not change the primary outcome.
    await expect(runCodexModelSwitch(spec)).rejects.toBe(primary);
  });
});
