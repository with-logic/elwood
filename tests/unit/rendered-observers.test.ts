/**
 * Unit tests for the shared rendered-frame observer.
 * Covers PRD §5.3 turn and blocked detection (C-TURN-01, C-ATTN-01, C-ATTN-02).
 */

import { describe, expect, test } from "vitest";
import { claudeScreenFactTable } from "../../src/claude/screen-table.ts";
import type { ElwoodActivityEvent } from "../../src/core/activity/index.ts";
import { AttentionWatcher } from "../../src/core/attention.ts";
import { observeRenderedFrame } from "../../src/core/rendered-observers.ts";
import type { RenderedFrame } from "../../src/core/screen-facts.ts";
import { TurnStateWatcher } from "../../src/core/turn-state.ts";
import type { ElwoodSessionStatus } from "../../src/core/types.ts";
import type { StatusEvidenceKind } from "../../src/runtime/status-evidence.ts";

const screen = (text: string): RenderedFrame => ({ text, title: "" });

const claudeWorking = "❯ \n  ⏵⏵ bypass permissions on · esc to interrupt · ← for agents";
const claudeIdle = "❯ \n  ⏵⏵ bypass permissions on (shift+tab to cycle)";
const claudePermission = "Do you want to create elwood.txt?\n ❯ 1. Yes\n   3. No\n Esc to cancel";

function harness(block: boolean) {
  const turn = new TurnStateWatcher();
  turn.arm();
  const submitted: StatusEvidenceKind[] = [];
  const activities: ElwoodActivityEvent[] = [];
  const observers = {
    turn,
    attention: new AttentionWatcher(),
    table: claudeScreenFactTable,
    agent: "claude" as const,
    elwoodSessionId: "elwood-1",
    emitActivity: (event: ElwoodActivityEvent) => activities.push(event),
  };
  const session = {
    status: "ready" as ElwoodSessionStatus,
    submitEvidence(kind: StatusEvidenceKind): { readonly to: ElwoodSessionStatus | undefined } {
      submitted.push(kind);
      return { to: kind === "blocking_prompt_shown" && block ? "blocked" : "running" };
    },
  };
  return { observers, session, submitted, activities };
}

describe("observeRenderedFrame", () => {
  test("C-TURN-01 submits turn edges from the frame", () => {
    const { observers, session, submitted } = harness(true);
    observeRenderedFrame(observers, screen(claudeWorking), session);
    observeRenderedFrame(observers, screen(claudeIdle), session);
    expect(submitted).toEqual(["rendered_turn_started", "rendered_turn_ended"]);
  });

  test("C-ATTN-01 emits attention activity when the block is accepted", () => {
    const { observers, session, submitted, activities } = harness(true);
    observeRenderedFrame(observers, screen(claudePermission), session);
    expect(submitted).toContain("blocking_prompt_shown");
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({ kind: "attention", label: "claude-permission-dialog" });
    // C-ATTN-02 the cleared edge submits without another activity.
    observeRenderedFrame(observers, screen(claudeIdle), session);
    expect(submitted).toContain("blocking_prompt_cleared");
    expect(activities).toHaveLength(1);
  });

  test("a rejected block submits evidence but emits no activity", () => {
    const { observers, session, activities } = harness(false);
    observeRenderedFrame(observers, screen(claudePermission), session);
    expect(activities).toHaveLength(0);
  });

  test("C-CLI-05 preserves stable attention before session construction completes", () => {
    const { observers, activities } = harness(true);
    expect(() => observeRenderedFrame(observers, screen(claudeWorking), undefined)).not.toThrow();
    observeRenderedFrame(observers, screen(claudePermission), undefined);
    expect(activities).toEqual([
      expect.objectContaining({ kind: "attention", label: "claude-permission-dialog" }),
    ]);
  });
});
