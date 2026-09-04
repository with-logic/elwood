/** Runtime loop restore tests (PRD §5.9/§9.3, C-LOOP-12/13/19). */

import { describe, expect, test, vi } from "vitest";
import { loadRuntimeLoopDefinitions } from "../../src/runtime/loop-restore.ts";
import type { PersistedLoopDefinition } from "../../src/state/loop-store.ts";

const fixed = (id: string, expiresAt: number): PersistedLoopDefinition => ({
  id,
  message: "check",
  mode: "fixed",
  intervalMs: 60_000,
  jitterMs: 0,
  createdAt: expiresAt - 604_800_000,
  expiresAt,
});

describe("loadRuntimeLoopDefinitions", () => {
  test("C-LOOP-12/13 silently prunes downtime expiry before runtime startup", () => {
    const write = vi.fn();
    const result = loadRuntimeLoopDefinitions("/state", "s1", 200, {
      read: () => [fixed("expired", 200), fixed("live", 201)],
      write,
    });
    expect(result.map(({ id }) => id)).toEqual(["live"]);
    expect(write).toHaveBeenCalledWith("/state", "s1", result);
  });

  test("does not rewrite a sidecar when every definition survives", () => {
    const definitions = [fixed("live", 201)];
    const write = vi.fn();
    expect(
      loadRuntimeLoopDefinitions("/state", "s1", 200, { read: () => definitions, write }),
    ).toBe(definitions);
    expect(write).not.toHaveBeenCalled();
  });

  test("C-LOOP-19 wraps prune persistence failure without prompt details", () => {
    expect(() =>
      loadRuntimeLoopDefinitions("/state", "s1", 200, {
        read: () => [fixed("expired", 200)],
        write: () => {
          throw new Error("disk rejected check");
        },
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "loop_persistence_failed",
        details: { loopId: "expired" },
      }),
    );
  });
});
