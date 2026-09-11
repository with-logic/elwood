/**
 * Unit coverage for the per-adapter reasoning-effort enums and the before-spawn
 * validator (PRD §5.1/§5.5, C-CLAUDE-20/C-CODEX-21). Real-CLI acceptance of the
 * forwarded flag/override is proven in tests/e2e/reasoning-effort.e2e.ts.
 */

import { describe, expect, test } from "vitest";
import { ElwoodError } from "../../src/core/errors.ts";
import {
  claudeReasoningEfforts,
  codexReasoningEfforts,
  validateReasoningEffort,
} from "../../src/core/reasoning-effort.ts";

describe("validateReasoningEffort", () => {
  test("returns a valid value unchanged and passes undefined through", () => {
    expect(
      validateReasoningEffort("high", claudeReasoningEfforts, "claude_invalid_reasoning_effort"),
    ).toBe("high");
    expect(
      validateReasoningEffort(undefined, claudeReasoningEfforts, "claude_invalid_reasoning_effort"),
    ).toBeUndefined();
  });

  test("C-CLAUDE-20 rejects an out-of-enum Claude value with the typed error listing valid values", () => {
    try {
      // `minimal` is valid for Codex but NOT Claude — the per-adapter enum catches it.
      validateReasoningEffort(
        "minimal" as (typeof claudeReasoningEfforts)[number],
        claudeReasoningEfforts,
        "claude_invalid_reasoning_effort",
      );
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ElwoodError);
      const elwood = error as ElwoodError;
      expect(elwood.code).toBe("claude_invalid_reasoning_effort");
      expect(elwood.message).toContain("minimal");
      expect(elwood.details["valid"]).toEqual(claudeReasoningEfforts);
    }
  });

  test("C-CODEX-21 rejects an out-of-enum Codex value with the typed error", () => {
    try {
      validateReasoningEffort(
        "bogus" as (typeof codexReasoningEfforts)[number],
        codexReasoningEfforts,
        "codex_invalid_reasoning_effort",
      );
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as ElwoodError).code).toBe("codex_invalid_reasoning_effort");
    }
  });
});
