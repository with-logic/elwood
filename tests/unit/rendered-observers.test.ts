/**
 * Unit tests for the shared rendered-frame observer.
 * Covers PRD §5.3 turn and blocked detection (C-TURN-01, C-ATTN-01, C-ATTN-02).
 */

import { describe, expect, test } from "vitest";
import {
  claudeScreenFactTable,
  claudeScreenFactTableForTrustPolicy,
} from "../../src/claude/screen-table.ts";
import type { ElwoodActivityEvent } from "../../src/core/activity/index.ts";
import { AttentionWatcher } from "../../src/core/attention.ts";
import { observeRenderedFrame, readRenderedFrame } from "../../src/core/rendered-observers.ts";
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

test("C-ATTN-03 a retained trust hold preserves one native rule match", () => {
  const { observers } = harness(true);
  observers.table = claudeScreenFactTableForTrustPolicy(false);
  const frame = screen(
    "Quick safety check: Is this a project you created or one you trust?\n1. Yes, I trust this folder",
  );
  const native = readRenderedFrame(observers, frame);
  const held = readRenderedFrame(observers, frame, "workspace_trust");
  expect(native.matched.map((match) => match.id)).toContain("claude-workspace_trust-prompt");
  expect(held).toEqual(native);
  const partial = readRenderedFrame(
    observers,
    screen("Loading the next screen"),
    "workspace_trust",
  );
  expect(partial.facts.blocking_prompt_visible).toBe(true);
  expect(partial.matched).toEqual([
    { id: "claude-workspace_trust-prompt", fact: "blocking_prompt_visible", region: "screen" },
  ]);
});

test.each([
  undefined,
  "workspace_trust",
])("C-ATTN-03 current unknown gate outranks trust ownership (%s)", (trustBlock) => {
  const { observers } = harness(true);
  observers.table = claudeScreenFactTableForTrustPolicy(false);
  const reading = readRenderedFrame(
    observers,
    screen("Do you trust the newly requested capability?\n1. Yes\n2. No\nEnter to confirm"),
    trustBlock,
    true,
  );
  expect(reading.matched.map(({ id }) => id)).toEqual(["claude-unknown_gate-prompt"]);
});

test("C-ATTN-03 adapters own the fallback suppressed by pending trust", () => {
  const { observers } = harness(true);
  observers.table = {
    ...claudeScreenFactTable,
    trustOwnedFallback: "adapter-retained-dialog",
    rules: [
      {
        id: "adapter-retained-dialog",
        fact: "blocking_prompt_visible",
        all: [/partial/],
        fallback: true,
      },
    ],
  };
  expect(readRenderedFrame(observers, screen("partial")).facts.blocking_prompt_visible).toBe(true);
  expect(readRenderedFrame(observers, screen("partial"), undefined, true).matched).toEqual([]);
  expect(readRenderedFrame(observers, screen("partial"), "workspace_trust").matched).toEqual([
    { id: "claude-workspace_trust-prompt", fact: "blocking_prompt_visible", region: "screen" },
  ]);
});

test("C-API-31 native work revokes recovery before reentrant status observers", () => {
  const { observers, session } = harness(true);
  let working = false;
  const target = {
    ...session,
    observeNativeWork(value: boolean) {
      working = value;
    },
    submitEvidence(kind: StatusEvidenceKind) {
      expect(working).toBe(kind === "rendered_turn_started");
      return { to: "running" as const };
    },
  };
  observeRenderedFrame(observers, screen(claudeWorking), target);
  observeRenderedFrame(observers, screen(claudeIdle), target);
});
