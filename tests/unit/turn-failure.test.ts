/**
 * Unit coverage for CODEX's turn-rejection evidence reader (PRD §12A.5, C-API-57): a transcript
 * `task_complete` carrying an `error` is failure evidence, and its ABSENCE never is — an empty
 * reply is a success (§12A.3). Claude's boundary-hook reader lives in
 * `turn-failure-claude.test.ts`; the runner that consumes both is in `turn-failure-runner.test.ts`.
 */

import { describe, expect, test } from "vitest";
import { codexFailureEvidence } from "../../src/codex/turn-failure.ts";
import { activity } from "./simple-turn-fakes.ts";

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

/** A `task_complete` whose `error` is an ARBITRARY shape (string, scalar, absent, …). */
function taskCompleteRaw(error: unknown): Readonly<Record<string, unknown>> {
  return {
    type: "event_msg",
    payload: { type: "task_complete", last_agent_message: null, error },
  };
}

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

  test("an error of ANY shape is a rejection — presence, never shape, is the signal", () => {
    // A non-object `error` must never read as success: that is the #19 bug reached by another
    // payload shape. A bare string, a scalar, or an unrecognized shape all still fail the turn.
    expect(codexFailureEvidence(transcript(taskCompleteRaw("out of quota")))?.message).toBe(
      "out of quota",
    );
    expect(codexFailureEvidence(transcript(taskCompleteRaw(500)))?.message).toBe(
      "Codex rejected the turn: 500",
    );
    expect(codexFailureEvidence(transcript(taskCompleteRaw(true)))?.message).toBe(
      "Codex rejected the turn: true",
    );
    // An unrecognized shape still fails, with a truthful generic reason.
    expect(codexFailureEvidence(transcript(taskCompleteRaw(["a"])))?.message).toBe(
      "Codex rejected the turn.",
    );
    // Only a genuinely ABSENT error is success (§12A.3) — `null` included.
    expect(codexFailureEvidence(transcript(taskCompleteRaw(null)))).toBeUndefined();
    expect(codexFailureEvidence(transcript(taskCompleteRaw(undefined)))).toBeUndefined();
  });

  test("the diagnostic classification is BOUNDED like the message", () => {
    // `info` reaches consumers through public `ElwoodError.details`, so an oversized
    // classification must not be retained unbounded by anything that logs or serializes it.
    const failure = codexFailureEvidence(
      transcript(taskComplete({ message: "r", codex_error_info: "c".repeat(5_000) })),
    );
    expect(failure?.info).toHaveLength(2_001); // 2000 chars + the ellipsis
  });

  test("a non-JSON, absent, or oversized reason stays truthful and bounded", () => {
    expect(
      codexFailureEvidence(transcript(taskComplete({ message: "plain reason" })))?.message,
    ).toBe("plain reason");
    // No usable message at all still reports a real reason rather than an empty error.
    expect(codexFailureEvidence(transcript(taskComplete({})))?.message).toBe(
      "Codex rejected the turn.",
    );
    // A non-string scalar message is RENDERED rather than dropped, so the reason stays useful.
    expect(codexFailureEvidence(transcript(taskComplete({ message: 42 })))?.message).toBe(
      "Codex rejected the turn: 42",
    );
    // A JSON envelope whose inner message is missing keeps the raw string.
    expect(
      codexFailureEvidence(transcript(taskComplete({ message: '{"error":{}}' })))?.message,
    ).toBe('{"error":{}}');
    const long = codexFailureEvidence(transcript(taskComplete({ message: "x".repeat(5_000) })));
    expect(long?.message).toHaveLength(2_001); // 2000 chars + the ellipsis
    // An oversized JSON envelope is truncated WITHOUT the nested parse (the unwrapped inner
    // message is not surfaced), so a multi-megabyte payload costs no parsing work.
    const huge = `{"error":{"message":"inner"}}${" ".repeat(5_000)}`;
    const bounded = codexFailureEvidence(transcript(taskComplete({ message: huge })));
    expect(bounded?.message).toHaveLength(2_001);
    expect(bounded?.message?.startsWith('{"error"')).toBe(true);
    // A non-string classification is dropped rather than carried as a bogus `info`.
    expect(
      codexFailureEvidence(transcript(taskComplete({ message: "r", codex_error_info: 7 })))?.info,
    ).toBeUndefined();
  });
});
