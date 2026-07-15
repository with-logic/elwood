/**
 * Focused coverage for the initial-ready-fallback warning builder + its persisted
 * validation. Covers PRD §5.3/§5.7 (C-API-42): an `initial_ready_fallback` warning
 * carries ONLY a bounded `reason` (`persist`/`listener`) — never raw content — and
 * survives a persist→resume round-trip while rejecting malformed shapes.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { initialReadyFallbackWarning } from "../../src/claude/initial-ready-fallback.ts";
import { createSessionRecord } from "../../src/state/store.ts";
import { validateSessionRecord } from "../../src/state/validate.ts";

const id = "initial-ready-target";

describe("C-API-42 initialReadyFallbackWarning", () => {
  test("carries the bounded reason and a content-free raw token for each variant", () => {
    for (const reason of ["persist", "listener"] as const) {
      const warning = initialReadyFallbackWarning(id, reason);
      expect(warning).toMatchObject({
        code: "initial_ready_fallback",
        agent: "claude",
        source: "lifecycle",
        reason,
      });
      expect(warning.raw).toBe(`initial_ready_fallback reason=${reason}`);
      // The message names only the bounded reason, never a raw system message.
      expect(warning.message).toContain(reason);
    }
  });
});

describe("C-API-42 initial_ready_fallback validation round-trip", () => {
  test("accepts a well-formed warning and gates malformed shapes", () => {
    const root = mkdtempSync(join(tmpdir(), "elwood-initial-ready-"));
    const record = JSON.parse(
      JSON.stringify(createSessionRecord({ stateDir: root, cwd: root, id })),
    ) as Record<string, unknown>;
    const warning = initialReadyFallbackWarning(id, "persist");
    expect(validateSessionRecord({ ...record, warnings: [warning] }, root, id)).not.toBeNull();
    // A non-allowlisted reason, off-agent, wrong source, or a missing field all fail.
    for (const bad of [
      { reason: "corrupt" },
      { reason: "conversation-derived-secret" },
      { agent: "codex" },
      { source: "terminal" },
      { message: 42 },
      { elwoodSessionId: 7 },
      { raw: null },
    ]) {
      expect(
        validateSessionRecord({ ...record, warnings: [{ ...warning, ...bad }] }, root, id),
      ).toBeNull();
    }
  });
});
