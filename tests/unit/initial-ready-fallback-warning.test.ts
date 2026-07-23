/**
 * Focused coverage for the initial-ready-fallback warning builder. Covers PRD
 * §5.3/§5.7 (C-API-42): an `initial_ready_fallback` warning is content-free (no raw
 * system message, no reason field) and is live-only (never persisted).
 */

import { describe, expect, test } from "vitest";
import { initialReadyFallbackWarning } from "../../src/runtime/initial-ready-fallback.ts";

const id = "initial-ready-target";

describe("C-API-42 initialReadyFallbackWarning", () => {
  test("is content-free for each agent and carries no reason field", () => {
    for (const agent of ["claude", "codex"] as const) {
      const warning = initialReadyFallbackWarning(agent, id);
      expect(warning).toMatchObject({
        code: "initial_ready_fallback",
        agent,
        source: "lifecycle",
        severity: "warning",
        elwoodSessionId: id,
        raw: "initial_ready_fallback",
      });
      expect(warning).not.toHaveProperty("reason");
      // The message names no raw system detail.
      expect(warning.message).not.toContain("boom");
    }
  });
});
