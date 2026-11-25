/** Normalize known native failure codes and structured diagnostics (C-API-65). */
import { expect, test } from "vitest";
import { codexTurnFailureActivity } from "../../src/codex/transcript/rejection.ts";
import { normalizeFinalTurnFailure } from "../../src/core/activity/turn-failure.ts";

test.each([
  ["billing_error", "quota_or_credit"],
  ["credit_balance_too_low", "quota_or_credit"],
  ["insufficient_quota", "quota_or_credit"],
  ["rate_limit", "rate_limited"],
  ["rate_limit_error", "rate_limited"],
  ["rate_limit_exceeded", "rate_limited"],
  ["usage_limit_exceeded", "usage_limit"],
  ["usage_limit_reached", "usage_limit"],
  ["model_not_found", "model_unavailable"],
  ["authentication_failed", "authentication"],
  ["authentication_error", "authentication"],
  ["cloud_credential_error", "authentication"],
  ["invalid_api_key", "authentication"],
  ["oauth_org_not_allowed", "authentication"],
  ["unauthorized", "authentication"],
  ["api_error", "network_or_api"],
  ["http_connection_failed", "network_or_api"],
  ["internal_server_error", "network_or_api"],
  ["overloaded_error", "network_or_api"],
  ["response_stream_connection_failed", "network_or_api"],
  ["response_stream_disconnected", "network_or_api"],
  ["response_too_many_failed_attempts", "network_or_api"],
  ["server_error", "network_or_api"],
  ["server_overloaded", "network_or_api"],
  ["context_length_exceeded", "context_too_long"],
  ["context_window_exceeded", "context_too_long"],
  ["prompt_too_long", "context_too_long"],
  ["max_output_tokens", "unknown"],
  ["constructor", "unknown"],
])("C-API-65 normalizes explicit native code %s", (code, category) => {
  expect(
    normalizeFinalTurnFailure({
      displayMessage: "harness message",
      boundedNativeErrorCode: code,
      nativeDiagnostic: "harness message",
    }).turnFailure,
  ).toEqual({
    category,
    message: "harness message",
    disposition: "final",
  });
});

test("C-API-65 a service code makes a generic Codex error specific", () => {
  const message =
    '{"type":"error","status":400,"error":{"code":"model_not_found","type":"rate_limit_error"}}';
  expect(
    normalizeFinalTurnFailure({
      displayMessage: message,
      boundedNativeErrorCode: "other",
      nativeDiagnostic: message,
    }).turnFailure,
  ).toEqual({
    category: "model_unavailable",
    message,
    disposition: "final",
  });
});

test.each([
  undefined,
  -1,
  1.25,
  "1800000000",
  9_007_199_254_740_992,
])("C-API-65 ignores missing and invalid reset seconds %s", (resets_at) => {
  const message = JSON.stringify({ error: { type: "usage_limit_reached", resets_at } });
  expect(
    normalizeFinalTurnFailure({
      displayMessage: message,
      boundedNativeErrorCode: "rate_limit",
      nativeDiagnostic: message,
    }).turnFailure,
  ).toEqual({
    category: "usage_limit",
    message,
    disposition: "final",
  });
});

test.each([
  '{"error":',
  '{"error":[]}',
  '{"message":"rate_limit"}',
  "The model said context too long and will retry.",
])("C-API-65 preserves unclassified diagnostics without inventing a retry (%s)", (message) => {
  expect(
    normalizeFinalTurnFailure({
      displayMessage: message,
      boundedNativeErrorCode: undefined,
      nativeDiagnostic: message,
    }).turnFailure,
  ).toEqual({
    category: "unknown",
    message,
    disposition: "final",
  });
});

test("C-API-65 does not treat an ordinary assistant record as authoritative failure", () => {
  expect(
    codexTurnFailureActivity("s1", "/tmp/rollout", {
      type: "response_item",
      payload: { type: "message", role: "assistant", content: [{ text: "model_not_found" }] },
    }),
  ).toBeUndefined();
  expect(
    codexTurnFailureActivity("s1", "/tmp/rollout", {
      type: "event_msg",
      payload: { type: "task_complete", turn_id: "turn", error: null },
    }),
  ).toBeUndefined();
});
