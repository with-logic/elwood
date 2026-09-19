/**
 * TIMING of a rejected turn (PRD §5.8, C-API-57): when the serializer's slot is released, and
 * how long the quiet window stays open for rejection evidence.
 *
 * Both are about a turn settling at the RIGHT moment rather than recognizing the right thing.
 * A rejection that arrives just after a quiet settle is lost exactly as thoroughly as one that
 * is never classified — the #19 empty-success bug reached by timing instead of logic.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { codexFailureEvidence } from "../../src/codex/turn-failure.ts";
import { activity, drive, runFakeTimed, runTurnFake } from "./simple-turn-fakes.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** One real `task_complete` transcript item, as codex-cli 0.155.0 writes it. */
function taskComplete(
  error?: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return {
    type: "event_msg",
    payload: { type: "task_complete", last_agent_message: null, ...(error ? { error } : {}) },
  };
}

/** The activity event a Codex transcript item arrives on. */
function transcript(raw: unknown) {
  return activity({ agent: "codex", kind: "other", label: "task_complete", raw });
}

/** The same, marked `source: "transcript"` as the real watcher emits it. */
function transcriptSignal(raw: unknown) {
  return activity({
    agent: "codex",
    kind: "other",
    label: "task_complete",
    source: "transcript",
    raw,
  });
}

describe("C-API-57 a rejected turn settles at the right moment", () => {
  test("a rejected turn reaches its boundary IMMEDIATELY, not via the drain window", async () => {
    // The serializer holds the next turn on `boundary`. A rejecting agent has FINISHED its turn,
    // so the slot must release at once rather than waiting out the post-failure drain. Measured:
    // with the immediate release the next turn starts in ~19ms; without it, ~749ms (the drain).
    // Asserting settle-before-any-timer-runs pins that without depending on wall-clock timing.
    const s = drive((s) => {
      s.emit("status", { status: "running" });
      s.emit("activity", transcript(taskComplete({ message: "nope" })));
      s.emit("status", { status: "ready" });
    });
    const turn = runTurnFake(s, {
      readFailureEvidence: codexFailureEvidence,
      drainMs: 10_000, // a drain-path release would need this to elapse
    });
    turn.events.next().catch(() => undefined); // drive the consumer; its error is asserted elsewhere
    let released = false;
    void turn.boundary.then(() => {
      released = true;
    });
    await vi.advanceTimersByTimeAsync(0); // no timer fires: only an immediate reach() can settle
    expect(released).toBe(true);
  });

  test("a stream of transcript events holds the quiet window until evidence lands", async () => {
    // A rejected Codex turn emits NON-CONTENT transcript events (`item_completed`, then
    // `task_complete`). None reach `gate.push()` — `toTurnEvent` yields nothing for them — so
    // before this they did not re-arm the quiet window and the turn could settle as an empty
    // success moments before its rejection arrived. Seventh variant of the #19 bug class, and
    // the first about TIMING rather than recognition.
    const s = drive((s) => {
      s.emit("status", { status: "running" });
      s.emit("hook", { hook_event_name: "UserPromptSubmit", prompt: "go" });
      s.emit("status", { status: "ready" });
      const itemCompleted = { type: "event_msg", payload: { type: "item_completed" } };
      setTimeout(() => s.emit("activity", transcriptSignal(itemCompleted)), 15);
      setTimeout(() => s.emit("activity", transcriptSignal(itemCompleted)), 30);
      setTimeout(() => s.emit("activity", transcriptSignal(taskComplete({ message: "late" }))), 45);
    });
    await expect(
      runFakeTimed(s, { readFailureEvidence: codexFailureEvidence }),
    ).rejects.toMatchObject({ code: "turn_failed", message: "late" });
  });
});
