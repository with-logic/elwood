/**
 * Focused coverage for startup-prompt activity emission.
 * Covers PRD §5.4 (C-API-18, C-CLAUDE-14).
 */

import { describe, expect, test } from "vitest";
import type { ElwoodActivityEvent } from "../../src/core/activity.ts";
import { emitStartupPromptActivity } from "../../src/core/startup-automation.ts";

function collect(): {
  events: ElwoodActivityEvent[];
  emit: (e: "activity", p: ElwoodActivityEvent) => void;
} {
  const events: ElwoodActivityEvent[] = [];
  return { events, emit: (_e, p) => events.push(p) };
}

describe("startup-prompt activity", () => {
  test("C-API-18 an answered prompt emits a startup_prompt activity", () => {
    const { events, emit } = collect();
    emitStartupPromptActivity({ emit }, "claude", "s1", {
      kind: "answered",
      prompt: "workspace_trust",
      input: "1",
    });
    expect(events[0]).toMatchObject({ kind: "startup_prompt", label: "workspace_trust" });
    expect(events[0]!.text).toContain("sent 1");
  });

  test("C-CLAUDE-14 a recognized-but-unanswerable prompt emits an attention activity", () => {
    const { events, emit } = collect();
    emitStartupPromptActivity({ emit }, "claude", "s1", {
      kind: "unanswerable",
      prompt: "mcp_trust",
    });
    expect(events[0]).toMatchObject({ kind: "attention", label: "mcp_trust", source: "terminal" });
    expect(events[0]!.text).toContain("no known option");
  });
});
