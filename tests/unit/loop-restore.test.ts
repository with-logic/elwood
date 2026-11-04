/** Runtime loop restore tests (PRD §5.9/§9.3, C-LOOP-12/13/19). */

import { ok } from "node:assert/strict";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { loadRuntimeLoopDefinitions } from "../../src/runtime/loop-restore.ts";
import type { StateFileWriter } from "../../src/state/launch-ownership.ts";
import type { PersistedLoopDefinition } from "../../src/state/loop-store.ts";
import { fixedLoop } from "../helpers/loops.ts";

/** Now, in each test: loops expiring then or earlier are pruned. */
const NOW = 1_800_000_000_000;

/** Reads a sidecar holding the supplied definitions. */
function sidecar(...definitions: PersistedLoopDefinition[]) {
  return () => ({ definitions });
}

describe("loadRuntimeLoopDefinitions", () => {
  test("C-LOOP-12/13 silently prunes downtime expiry before runtime startup", () => {
    const write = vi.fn<StateFileWriter>();
    const read = sidecar(fixedLoop("expired", NOW), fixedLoop("live", NOW + 1));
    const result = loadRuntimeLoopDefinitions(
      "/state",
      "s1",
      { readFile: () => undefined, writeFile: write },
      NOW,
      read,
    );
    expect(result.map(({ id }) => id)).toEqual(["live"]);
    const firstCall = write.mock.calls[0];
    ok(firstCall, "The prune publishes its surviving definitions.");
    const [path, text] = firstCall;
    expect(path).toBe(join("/state", "sessions", "s1", "loops.json"));
    expect(JSON.parse(text)).toMatchObject({ loops: [{ id: "live" }] });
  });

  test("does not rewrite a sidecar when every definition survives", () => {
    const definitions = [fixedLoop("live", NOW + 1)];
    const write = vi.fn<StateFileWriter>();
    const read = () => ({ definitions });
    expect(
      loadRuntimeLoopDefinitions(
        "/state",
        "s1",
        { readFile: () => undefined, writeFile: write },
        NOW,
        read,
      ),
    ).toBe(definitions);
    expect(write).not.toHaveBeenCalled();
  });

  test("C-LOOP-19 wraps prune persistence failure without prompt details", () => {
    const fail = () => {
      throw new Error("disk rejected check");
    };
    expect(() =>
      loadRuntimeLoopDefinitions(
        "/state",
        "s1",
        { readFile: () => undefined, writeFile: fail },
        NOW,
        sidecar(fixedLoop("expired", NOW)),
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "loop_persistence_failed",
        details: { loopId: "expired" },
      }),
    );
  });
});
