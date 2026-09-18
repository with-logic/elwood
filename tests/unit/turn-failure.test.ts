/**
 * Unit coverage for CODEX's turn-rejection evidence and the runner that consumes it (PRD
 * §12A.5, C-API-57): a turn the AGENT rejected fails with `turn_failed` instead of settling as
 * an empty success, while a turn that is merely EMPTY still succeeds (§12A.3). Claude's
 * boundary-hook half lives in `turn-failure-claude.test.ts`.
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
    timestamp: "2026-09-18T21:30:41.561Z",
    type: "event_msg",
    payload: {
      type: "task_complete",
      turn_id: "01a0b66d-a980-7111-9849-d2a96bc22ed5",
      last_agent_message: null,
      ...(error === undefined ? {} : { error }),
      duration_ms: 5997,
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

describe("C-API-57 Codex reports a rejected turn from its transcript", () => {
  test("a task_complete carrying an error is failure evidence", () => {
    // The REAL payload captured from codex-cli 0.155.0 for a bogus `--model` turn.
    const failure = codexFailureEvidence(
      transcript(
        taskComplete({
          message:
            '{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'gpt-nonexistent-bogus-model\' model is not supported when using Codex with a ChatGPT account."}}',
          codex_error_info: "other",
        }),
      ),
    );
    // The JSON envelope is unwrapped to the human-readable reason.
    expect(failure?.message).toBe(
      "The 'gpt-nonexistent-bogus-model' model is not supported when using Codex with a ChatGPT account.",
    );
    expect(failure?.info).toBe("other");
  });

  test("a usage-limit rejection is evidence under a DIFFERENT codex_error_info", () => {
    // Presence of `error` is the signal — never the value of `codex_error_info`, which differs
    // between rejection causes (`other` for a bad model, `usage_limit_exceeded` for quota).
    const failure = codexFailureEvidence(
      transcript(
        taskComplete({
          message: "You've hit your usage limit.",
          codex_error_info: "usage_limit_exceeded",
        }),
      ),
    );
    expect(failure).toEqual({
      message: "You've hit your usage limit.",
      info: "usage_limit_exceeded",
    });
  });

  test("§12A.3 a task_complete with NO error is not failure — an empty reply still succeeds", () => {
    // The exact confusion #19 warns about: `last_agent_message: null` with no assistant text is
    // a legitimately EMPTY successful turn, not a failure.
    expect(codexFailureEvidence(transcript(taskComplete()))).toBeUndefined();
  });

  test("ordinary transcript items and malformed payloads carry no evidence", () => {
    expect(
      codexFailureEvidence(transcript({ payload: { type: "agent_message" } })),
    ).toBeUndefined();
    expect(codexFailureEvidence(transcript({ payload: "not-a-record" }))).toBeUndefined();
    expect(codexFailureEvidence(transcript(undefined))).toBeUndefined();
  });

  test("a non-JSON, absent, or oversized reason stays truthful and bounded", () => {
    expect(
      codexFailureEvidence(transcript(taskComplete({ message: "plain reason" })))?.message,
    ).toBe("plain reason");
    // No usable message at all still reports a real reason rather than an empty error.
    expect(codexFailureEvidence(transcript(taskComplete({})))?.message).toBe(
      "Codex rejected the turn.",
    );
    expect(codexFailureEvidence(transcript(taskComplete({ message: 42 })))?.message).toBe(
      "Codex rejected the turn.",
    );
    // A JSON envelope whose inner message is missing keeps the raw string.
    expect(
      codexFailureEvidence(transcript(taskComplete({ message: '{"error":{}}' })))?.message,
    ).toBe('{"error":{}}');
    const long = codexFailureEvidence(transcript(taskComplete({ message: "x".repeat(5_000) })));
    expect(long?.message).toHaveLength(2_001); // 2000 chars + the ellipsis
    // A non-string classification is dropped rather than carried as a bogus `info`.
    expect(
      codexFailureEvidence(transcript(taskComplete({ message: "r", codex_error_info: 7 })))?.info,
    ).toBeUndefined();
  });
});
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
