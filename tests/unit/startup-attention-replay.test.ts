/**
 * Startup attention replay coverage (PRD §12A.2, C-CLI-05).
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { claudeScreenFactTable } from "../../src/claude/screen-table.ts";
import type { ElwoodActivityEvent } from "../../src/core/activity.ts";
import { AttentionWatcher } from "../../src/core/attention.ts";
import { observeRenderedFrame } from "../../src/core/rendered-observers.ts";
import { TerminalReplayBuffer } from "../../src/core/terminal-replay.ts";
import { TurnStateWatcher } from "../../src/core/turn-state.ts";
import { TypedEmitter } from "../../src/events/emitter.ts";

type Map = { activity: ElwoodActivityEvent };
const event = (kind: ElwoodActivityEvent["kind"], label: string): ElwoodActivityEvent => ({
  elwoodSessionId: "s1",
  agent: "claude",
  source: "terminal",
  kind,
  label,
});

afterEach(() => vi.useRealTimers());

describe("startup attention replay", () => {
  test("C-CLI-05 retains only stable attention until the post-return macrotask", async () => {
    vi.useFakeTimers();
    const emitter = new TypedEmitter<Map>();
    const replay = new TerminalReplayBuffer("s1");
    replay.captureStartupAttention(emitter);
    emitter.emit("activity", event("status", "running"));
    emitter.emit("activity", event("attention", "workspace_trust"));
    const labels: string[] = [];
    replay.replayAttention((activity) => labels.push(activity.label));
    expect(labels).toEqual(["workspace_trust"]);
    replay.releaseStartupAttentionAfterReturn();
    await vi.runAllTimersAsync();
    expect(emitter.hasListeners("activity")).toBe(false);
    replay.replayAttention(() => labels.push("late"));
    expect(labels).toEqual(["workspace_trust"]);
  });

  test("release is safe without capture and replay preserves consumer failures", async () => {
    vi.useFakeTimers();
    const replay = new TerminalReplayBuffer("s1");
    replay.releaseStartupAttentionAfterReturn();
    await vi.runAllTimersAsync();
    const emitter = new TypedEmitter<Map>();
    replay.captureStartupAttention(emitter);
    emitter.emit("activity", event("attention", "blocked"));
    expect(() =>
      replay.replayAttention(() => {
        throw new Error("consumer");
      }),
    ).toThrow(/consumer/iu);
  });

  test("C-CLI-05 pre-session blocking attention replays without a later duplicate", () => {
    const emitter = new TypedEmitter<Map>();
    const replay = new TerminalReplayBuffer("s1");
    replay.captureStartupAttention(emitter);
    const observers = {
      turn: new TurnStateWatcher(),
      attention: new AttentionWatcher(),
      table: claudeScreenFactTable,
      agent: "claude" as const,
      elwoodSessionId: "s1",
      emitActivity: (activity: ElwoodActivityEvent) => emitter.emit("activity", activity),
    };
    const frame = {
      text: "Do you want to create elwood.txt?\n ❯ 1. Yes\n   3. No\n Esc to cancel",
      title: "",
    };
    observeRenderedFrame(observers, frame, undefined);
    const labels: string[] = [];
    replay.replayAttention((activity) => labels.push(activity.label));
    observeRenderedFrame(observers, frame, {
      status: "running",
      submitEvidence: () => ({ to: "blocked" as const }),
    });
    expect(labels).toEqual(["claude-permission-dialog"]);
  });
});
