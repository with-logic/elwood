/**
 * Unit tests for hook-result activity label mapping.
 * Covers PRD §5.4 (C-API-12).
 */

import { describe, expect, test } from "vitest";
import { activityFromHookResult } from "../../src/core/activity/index.ts";

describe("Elwood hook-result activity", () => {
  test("C-API-12 maps hook result labels for known response variants", () => {
    const label = (event: string, result: unknown) =>
      activityFromHookResult("claude", "elwood-5", event, result, false).label;
    expect(label("SessionStart", { additionalContext: "ctx" })).toBe("context");
    expect(label("Elicitation", { action: "accept" })).toBe("accept");
    expect(label("PermissionDenied", { retry: true })).toBe("retry");
    expect(label("WorktreeCreate", { worktreePath: "/tmp/work" })).toBe("worktree");
    expect(activityFromHookResult("codex", "elwood-5", "Stop", undefined, true)).toMatchObject({
      hookEventName: "Stop",
      failedOpen: true,
    });
    expect(
      activityFromHookResult("codex", "elwood-5", "Stop", { ignored: true }, false).label,
    ).toBe("response");
  });
});
