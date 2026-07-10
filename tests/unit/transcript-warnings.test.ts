/**
 * Focused coverage for the transcript diagnostic warning builders.
 * Covers PRD §5.4 (C-CLAUDE-15): content-free warnings from bounded notices.
 */

import { describe, expect, test } from "vitest";
import { pollErrorWarning } from "../../src/claude/transcript/warnings.ts";

describe("C-CLAUDE-15 transcript warning builders", () => {
  test("pollErrorWarning stringifies both Error and non-Error causes", () => {
    expect(pollErrorWarning("s1", new Error("boom"))).toMatchObject({
      code: "transcript_poll_stopped",
      reason: "boom",
    });
    // A non-Error cause is String()-ed rather than dropped.
    const fromString = pollErrorWarning("s1", "raw-reason");
    expect(fromString).toMatchObject({ reason: "raw-reason" });
    expect(fromString.message).toContain("raw-reason");
  });
});
