/**
 * Codex's transcript rejection evidence (PRD §5.8, C-API-60): only an `event_msg`
 * `task_complete` with an `error` record and a nonblank `turn_id` is a rejection. Its message is
 * the bounded error message, and `agentError` names the `codex_error_info` variant.
 */

import { describe, expect, test } from "vitest";
import { codexTurnRejection } from "../../src/codex/transcript/rejection.ts";

// The record real Codex 0.164.0 committed for a turn run with an unknown model.
const captured = {
  timestamp: "2026-10-25T17:41:05.145Z",
  ordinal: 9,
  type: "event_msg",
  payload: {
    type: "task_complete",
    root_turn_id: "01a17426-ca6a-7d10-b466-543d1914d1d9",
    turn_id: "01a17426-ca6a-7d10-b466-543d1914d1d9",
    last_agent_message: null,
    error: {
      message:
        '{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'gpt-elwood-nonexistent-model\' model is not supported when using Codex with a ChatGPT account.","code":"model_not_found"}}',
      codex_error_info: "other",
    },
  },
};

function completed(error: unknown, turn_id: unknown = "turn-1") {
  return { type: "event_msg", payload: { type: "task_complete", turn_id, error } };
}

describe("codexTurnRejection", () => {
  test("C-API-60 reads the captured rejection: its turn, error message and error variant", () => {
    expect(codexTurnRejection(captured)).toEqual({
      turnId: "01a17426-ca6a-7d10-b466-543d1914d1d9",
      failure: { message: captured.payload.error.message, agentError: "other" },
    });
  });

  test("C-API-60 names a variant with fields by its single key", () => {
    const info = { http_connection_failed: { http_status_code: 502 } };
    expect(
      codexTurnRejection(completed({ message: "bad gateway", codex_error_info: info })),
    ).toMatchObject({ failure: { message: "bad gateway", agentError: "http_connection_failed" } });
  });

  test("C-API-60 falls back to the variant, then to a generic message, without a message", () => {
    expect(codexTurnRejection(completed({ codex_error_info: "usage_limit_exceeded" }))).toEqual({
      turnId: "turn-1",
      failure: {
        message: "Codex rejected the turn: usage_limit_exceeded",
        agentError: "usage_limit_exceeded",
      },
    });
    for (const info of [undefined, " ", 7, { a: 1, b: 2 }, {}])
      expect(codexTurnRejection(completed({ message: "", codex_error_info: info }))).toEqual({
        turnId: "turn-1",
        failure: { message: "Codex rejected the turn.", agentError: undefined },
      });
  });

  test("C-API-60 bounds an oversized error message", () => {
    const message = "x".repeat(5_000);
    const failure = codexTurnRejection(completed({ message }))?.failure;
    expect(failure?.message).toBe(`${"x".repeat(2_000)}…`);
  });

  test("C-API-60 ignores everything but a failed task_complete naming a turn", () => {
    const error = { message: "failed" };
    for (const item of [
      undefined,
      "event_msg",
      { type: "response_item", payload: completed(error).payload },
      { type: "event_msg" },
      { type: "event_msg", payload: { type: "turn_aborted", turn_id: "turn-1", error } },
      completed(null),
      completed("failed"),
      { type: "event_msg", payload: { type: "task_complete", error } },
      completed(error, ""),
      completed(error, 7),
    ])
      expect(codexTurnRejection(item)).toBeUndefined();
  });
});
