/**
 * Focused coverage for completion-aware startup-prompt write settlement.
 * Covers PRD §5.1, §5.4, §5.7 (C-CLAUDE-16, C-CODEX-17).
 */

import { describe, expect, test, vi } from "vitest";
import type { ElwoodActivityEvent } from "../../src/core/activity.ts";
import type { SettledStartupOutcome, StartupWarningSink } from "../../src/core/startup-write.ts";
import { emitSettledStartupOutcomes } from "../../src/core/startup-write.ts";
import type { ElwoodWarningEvent } from "../../src/core/warnings.ts";

function collect() {
  const events: ElwoodActivityEvent[] = [];
  return { events, emit: (_e: "activity", p: ElwoodActivityEvent) => events.push(p) };
}

function sink(): StartupWarningSink & { warnings: ElwoodWarningEvent[] } {
  const warnings: ElwoodWarningEvent[] = [];
  return { warnings, recordWarnings: (w) => warnings.push(...w) };
}

describe("emitSettledStartupOutcomes", () => {
  test("C-CLAUDE-14 a write-less option_pending outcome emits its attention activity immediately", () => {
    const { events, emit } = collect();
    const outcomes: readonly SettledStartupOutcome<"claude">[] = [
      { outcome: { kind: "option_pending", prompt: "mcp_trust" } },
    ];
    emitSettledStartupOutcomes({ emit }, "claude", "s1", outcomes, sink());
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "attention", label: "mcp_trust" });
  });

  test("C-CLAUDE-16 an answered outcome emits startup_prompt activity only AFTER the write fulfills", async () => {
    const { events, emit } = collect();
    const warnings = sink();
    const outcomes: readonly SettledStartupOutcome<"claude">[] = [
      {
        outcome: { kind: "answered", prompt: "workspace_trust", input: "1" },
        settled: Promise.resolve(),
      },
    ];
    emitSettledStartupOutcomes({ emit }, "claude", "s1", outcomes, warnings);
    // Nothing is emitted synchronously — the activity waits for the write.
    expect(events).toEqual([]);
    await Promise.resolve();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "startup_prompt", label: "workspace_trust" });
    expect(warnings.warnings).toEqual([]);
  });

  test("C-CLAUDE-16 a REJECTED write emits a bounded warning and NO false startup_prompt activity", async () => {
    const { events, emit } = collect();
    const warnings = sink();
    const outcomes: readonly SettledStartupOutcome<"claude">[] = [
      {
        outcome: { kind: "answered", prompt: "browser_tools", input: "esc" },
        settled: Promise.reject(new Error("pty closed")),
      },
    ];
    emitSettledStartupOutcomes({ emit }, "claude", "s1", outcomes, warnings);
    await vi.waitFor(() => expect(warnings.warnings).toHaveLength(1));
    expect(events).toEqual([]);
    expect(warnings.warnings[0]).toMatchObject({
      code: "startup_prompt_write_failed",
      agent: "claude",
      source: "terminal",
      label: "browser_tools",
    });
    // The bounded warning carries only the label, never raw prompt/screen content.
    expect(warnings.warnings[0]?.raw).toBe("startup_prompt_write_failed label=browser_tools");
  });

  test("C-CODEX-17 a rejected write with NO warning sink drops silently rather than throwing", async () => {
    const { events, emit } = collect();
    const outcomes: readonly SettledStartupOutcome<"codex">[] = [
      {
        outcome: { kind: "answered", prompt: "update", input: "2" },
        settled: Promise.reject(new Error("pty closed")),
      },
    ];
    // Undefined sink: the optional-chaining path must not throw and must emit no activity.
    emitSettledStartupOutcomes({ emit }, "codex", "s1", outcomes, undefined);
    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual([]);
  });
});
