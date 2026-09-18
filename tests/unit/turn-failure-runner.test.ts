/**
 * Unit coverage for the RUNNER that consumes adapter turn-rejection evidence (PRD §12A.5,
 * C-API-57): a turn the AGENT rejected fails with `turn_failed` rather than settling as an
 * empty success, while a merely EMPTY turn still succeeds (§12A.3). The adapter readers
 * themselves live in `turn-failure.test.ts` (Codex) and `turn-failure-claude.test.ts` (Claude).
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { claudeBoundarySignal } from "../../src/claude/turn-failure.ts";
import { codexFailureEvidence } from "../../src/codex/turn-failure.ts";
import { activity, drive, runFakeTimed } from "./simple-turn-fakes.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** One real `task_complete` transcript item, as codex-cli 0.155.0 writes it. */
function taskComplete(
  error?: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return {
    type: "event_msg",
    payload: {
      type: "task_complete",
      turn_id: "01a0b66d-a980-7111-9849-d2a96bc22ed5",
      last_agent_message: null,
      ...(error === undefined ? {} : { error }),
    },
  };
}

/** Both adapters' readers at once, to prove neither misfires on the other's traffic. */
const bothReaders = {
  readBoundarySignal: claudeBoundarySignal,
  readFailureEvidence: codexFailureEvidence,
};

/** The activity event a Codex transcript item arrives on. */
function transcript(raw: unknown) {
  return activity({ agent: "codex", kind: "other", label: "task_complete", raw });
}

describe("C-API-57 the runner fails a rejected turn instead of reporting empty success", () => {
  test("Codex transcript evidence rejects the turn with turn_failed", async () => {
    const s = drive((s) => {
      s.emit("status", { status: "running" });
      // No `Stop` hook EVER arrives on this path — the rejection is transcript-only.
      s.emit(
        "activity",
        transcript(taskComplete({ message: "nope", codex_error_info: "usage_limit_exceeded" })),
      );
      s.emit("status", { status: "ready" });
    });
    await expect(
      runFakeTimed(s, { readFailureEvidence: codexFailureEvidence }),
    ).rejects.toMatchObject({
      code: "turn_failed",
      message: "nope",
      details: { info: "usage_limit_exceeded" },
    });
  });

  test("Claude StopFailure rejects the turn with turn_failed", async () => {
    const s = drive((s) => {
      s.emit("status", { status: "running" });
      s.emit("hook", { hook_event_name: "StopFailure", error: "rate_limit" });
      s.emit("status", { status: "ready" });
    });
    await expect(
      runFakeTimed(s, { readBoundarySignal: claudeBoundarySignal }),
    ).rejects.toMatchObject({
      code: "turn_failed",
      message: "Claude rejected the turn: rate_limit",
    });
  });

  test("§12A.3 a genuinely EMPTY turn still succeeds — absence of text is not failure", async () => {
    // The obvious wrong implementation would fail this turn. A `Stop` with no text, no assistant
    // activity, and a `task_complete` WITHOUT an error is a successful empty response.
    const s = drive((s) => {
      s.emit("status", { status: "running" });
      s.emit("activity", transcript(taskComplete()));
      s.emit("hook", { hook_event_name: "Stop", last_assistant_message: null });
      s.emit("status", { status: "ready" });
    });
    expect(await runFakeTimed(s, bothReaders)).toEqual([]);
  });

  test("a successful turn with text is unaffected by the failure readers", async () => {
    const s = drive((s) => {
      s.emit("status", { status: "running" });
      s.emit("hook", { hook_event_name: "Stop", last_assistant_message: "HELLO" });
      s.emit("status", { status: "ready" });
      queueMicrotask(() => s.emit("activity", activity({ text: "HELLO", turnId: "t1" })));
    });
    expect(await runFakeTimed(s, bothReaders)).toEqual([{ type: "text", text: "HELLO" }]);
  });

  test("a TAGGED contentless rejection fails the turn — the common rejection shape", async () => {
    // The real shape (codex-cli 0.155.0): a rejected turn emits NO assistant content, so nothing
    // binds `turnId`, yet its `task_complete` IS tagged (`payload.turn_id` → `activity.turnId`).
    // Filtering that first tagged failure out would resurrect the #19 empty-success bug.
    const s = drive((s) => {
      s.emit("status", { status: "running" });
      s.emit(
        "activity",
        activity({
          agent: "codex",
          kind: "other",
          label: "task_complete",
          turnId: "T1",
          raw: taskComplete({ message: "nope" }),
        }),
      );
      s.emit("status", { status: "ready" });
    });
    await expect(
      runFakeTimed(s, { readFailureEvidence: codexFailureEvidence }),
    ).rejects.toMatchObject({ code: "turn_failed", message: "nope" });
  });

  test("a rejected turn is never re-submitted to the agent", async () => {
    // The acceptance watchdog replays a prompt it believes was never accepted. A turn the agent
    // REJECTED was accepted and refused, so replaying it would re-run a refused turn.
    const s = drive((s) => {
      s.emit("status", { status: "running" });
      s.emit("activity", transcript(taskComplete({ message: "nope" })));
      s.emit("status", { status: "ready" });
    });
    await expect(
      runFakeTimed(s, { readFailureEvidence: codexFailureEvidence }),
    ).rejects.toMatchObject({ code: "turn_failed" });
    expect(s.submissions).toBe(1);
  });

  test("repeated evidence cannot overwrite the first committed failure", async () => {
    const s = drive((s) => {
      s.emit("status", { status: "running" });
      s.emit("activity", transcript(taskComplete({ message: "first" })));
      s.emit("activity", transcript(taskComplete({ message: "second" })));
      s.emit("status", { status: "ready" });
    });
    await expect(
      runFakeTimed(s, { readFailureEvidence: codexFailureEvidence }),
    ).rejects.toMatchObject({ code: "turn_failed", message: "first" });
  });
});
