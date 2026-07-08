/**
 * The dev app's status entry carries the explain reason from the latest
 * status decision.
 * Covers PRD §5.3 and C-API-33.
 */

import { describe, expect, test } from "vitest";
import { statusEvent } from "../../src/app/web-events.ts";

describe("dev app status decisions", () => {
  test("C-API-33 the explain reason enriches the status entry when supplied", () => {
    const decision = {
      evidence: "blocking_prompt_shown",
      from: "running",
      to: "blocked",
      reason: "applied",
    } as const;
    const enriched = statusEvent({ elwoodSessionId: "s1", status: "blocked" }, decision);
    expect(enriched).toMatchObject({ summary: "blocked — applied", tags: ["blocked"] });
  });

  test("C-API-33 the entry falls back to the bare status without a decision", () => {
    expect(statusEvent({ elwoodSessionId: "s1", status: "ready" })).toMatchObject({
      summary: "ready",
      tags: ["ready"],
    });
  });
});
