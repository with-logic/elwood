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

  test("C-CLAUDE-14 an option_pending prompt emits a transient attention activity, no durable warning", () => {
    const { events, emit } = collect();
    // The render-delay state is TRANSIENT: it emits only a fire-once attention
    // activity with accurate "awaiting a later frame" text — never a persisted
    // "not auto-answered" warning that would go stale once the prompt is answered.
    emitStartupPromptActivity({ emit }, "claude", "s1", {
      kind: "option_pending",
      prompt: "mcp_trust",
    });
    expect(events[0]).toMatchObject({ kind: "attention", label: "mcp_trust", source: "terminal" });
    expect(events[0]!.text).toContain("not rendered yet");
    expect(events[0]!.text).toContain("awaiting a later frame");
  });
});
