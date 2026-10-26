/** Runtime loop restore tests (PRD §5.9/§9.3, C-LOOP-12/13/19). */

import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { LOOP_EXPIRATION_MS } from "../../src/core/loops/constants.ts";
import { loadRuntimeLoopDefinitions } from "../../src/runtime/loop-restore.ts";
import type { PersistedLoopDefinition } from "../../src/state/loop-store.ts";

/** Now, in each test: loops expiring then or earlier are pruned. */
const NOW = 1_800_000_000_000;

const fixed = (id: string, expiresAt: number): PersistedLoopDefinition => ({
  id,
  message: "check",
  mode: "fixed",
  intervalMs: 60_000,
  jitterMs: 0,
  createdAt: expiresAt - LOOP_EXPIRATION_MS,
  expiresAt,
});

/** Reads a sidecar holding `definitions` from the text "read". */
function sidecar(...definitions: PersistedLoopDefinition[]) {
  return () => ({ definitions, text: "read" });
}

describe("loadRuntimeLoopDefinitions", () => {
  test("C-LOOP-12/13 silently prunes downtime expiry before runtime startup", () => {
    const write = vi.fn();
    const read = sidecar(fixed("expired", NOW), fixed("live", NOW + 1));
    const result = loadRuntimeLoopDefinitions("/state", "s1", write, NOW, read);
    expect(result.map(({ id }) => id)).toEqual(["live"]);
    const [path, text, readText] = write.mock.calls[0] as [string, string, string];
    expect(path).toBe(join("/state", "sessions", "s1", "loops.json"));
    expect(JSON.parse(text)).toMatchObject({ loops: [{ id: "live" }] });
    // The prune hands over the text it read, so the launch need not read it again.
    expect(readText).toBe("read");
  });

  test("does not rewrite a sidecar when every definition survives", () => {
    const definitions = [fixed("live", NOW + 1)];
    const write = vi.fn();
    const read = () => ({ definitions, text: "read" });
    expect(loadRuntimeLoopDefinitions("/state", "s1", write, NOW, read)).toBe(definitions);
    expect(write).not.toHaveBeenCalled();
  });

  test("C-LOOP-19 wraps prune persistence failure without prompt details", () => {
    const fail = () => {
      throw new Error("disk rejected check");
    };
    expect(() =>
      loadRuntimeLoopDefinitions("/state", "s1", fail, NOW, sidecar(fixed("expired", NOW))),
    ).toThrowError(
      expect.objectContaining({
        code: "loop_persistence_failed",
        details: { loopId: "expired" },
      }),
    );
  });
});
