/** Keep authoritative failure metadata when the public diagnostic is truncated (C-API-65). */
import { expect, expectTypeOf, test } from "vitest";
import { claudeTurnFailureActivity } from "../../src/claude/hooks/stop-failure.ts";
import { codexTurnFailureActivity } from "../../src/codex/transcript/rejection.ts";
import { boundedDiagnostic } from "../../src/core/simple/boundary-signal.ts";
import type { ElwoodActivityEvent } from "../../src/index.ts";

const oversized = JSON.stringify({
  type: "error",
  status: 429,
  error: {
    code: "usage_limit_reached",
    resets_at: 1800000000,
    message: "x".repeat(2200),
  },
});

test("Codex preserves the supplied reset even when the display diagnostic truncates", () => {
  const failure = codexTurnFailureActivity({
    elwoodSessionId: "s1",
    path: "/tmp/rollout",
    item: {
      type: "event_msg",
      payload: {
        type: "task_complete",
        turn_id: "codex-prior",
        error: { message: oversized, codex_error_info: "other" },
      },
    },
  });
  expect(failure).toMatchObject({
    label: "usage_limit",
    turnFailure: {
      category: "usage_limit",
      message: `${oversized.slice(0, 2000)}…`,
      resetsAtUnixSeconds: 1800000000,
    },
  });
});

const quotaExceededMessage = "Quota exceeded. Check your plan and billing details.";
const ownerCreditsMessage = "Your workspace is out of credits. Add credits to continue.";
const memberCreditsMessage =
  "Your workspace is out of credits. Ask your workspace owner to refill in order to continue.";

test.each([
  ["usage_limit_exceeded", ownerCreditsMessage, "quota_or_credit"],
  ["usage_limit_exceeded", memberCreditsMessage, "quota_or_credit"],
  ["usage_limit_exceeded", `${ownerCreditsMessage} Extra text.`, "usage_limit"],
  ["usage_limit_exceeded", "You've hit your usage limit. Try again later.", "usage_limit"],
  ["other", ownerCreditsMessage, "unknown"],
  ["usage_limit_exceeded", quotaExceededMessage, "quota_or_credit"],
  ["usage_limit_exceeded", `${quotaExceededMessage} Extra text.`, "usage_limit"],
  [
    { response_too_many_failed_attempts: { http_status_code: 429 } },
    "exceeded retry limit, last status: 429 Too Many Requests",
    "rate_limited",
  ],
  [{ http_connection_failed: { http_status_code: 429 } }, "unexpected status 429", "rate_limited"],
  [
    { http_connection_failed: { http_status_code: 402 } },
    "unexpected status 402 Payment Required",
    "quota_or_credit",
  ],
  // The status comes only from `codex_error_info`, so these messages naming one change nothing.
  [
    { http_connection_failed: { http_status_code: 503 } },
    "unexpected status 503, after 429 Too Many Requests and 402 Payment Required",
    "network_or_api",
  ],
  [
    { http_connection_failed: { http_status_code: "429" } },
    "unexpected status 429 Too Many Requests",
    "network_or_api",
  ],
  [
    { response_too_many_failed_attempts: 429 },
    "exceeded retry limit, last status: 429 Too Many Requests",
    "network_or_api",
  ],
  ["other", "exceeded retry limit, last status: 429 Too Many Requests", "unknown"],
  [{}, "unexpected status 402 Payment Required", "unknown"],
  [{ a: { http_status_code: 429 }, b: {} }, "two kinds", "unknown"],
])("C-API-65 Codex classifies %s with diagnostic %s", (codexErrorInfo, message, category) => {
  const failure = codexTurnFailureActivity({
    elwoodSessionId: "s1",
    path: "/tmp/rollout",
    item: {
      type: "event_msg",
      payload: {
        type: "task_complete",
        turn_id: "codex-prior",
        error: { message, codex_error_info: codexErrorInfo },
      },
    },
  });
  expect(failure).toMatchObject({
    label: category,
    turnFailure: { category, disposition: "final", message },
  });
});

test("Claude preserves the supplied reset even when the display diagnostic truncates", () => {
  const failure = claudeTurnFailureActivity("s1", {
    hook_event_name: "StopFailure",
    session_id: "claude",
    cwd: "/tmp/example",
    error: "rate_limit",
    error_details: oversized,
  });
  expect(failure).not.toHaveProperty("turnId");
  expect(failure).toMatchObject({
    label: "usage_limit",
    turnFailure: {
      category: "usage_limit",
      message: `${oversized.slice(0, 2000)}…`,
      resetsAtUnixSeconds: 1800000000,
    },
  });
});

test("C-API-65 preserves Codex identity and decoded category in the public activity type", () => {
  type CodexFailure = Extract<ElwoodActivityEvent, { kind: "turn_failure"; agent: "codex" }>;
  type Failure = Extract<ElwoodActivityEvent, { kind: "turn_failure" }>;
  expectTypeOf<Failure["turnFailure"]["disposition"]>().toEqualTypeOf<"final">();
  type UsageLimit = Extract<CodexFailure, { label: "usage_limit" }>;
  expectTypeOf<CodexFailure["turnId"]>().toEqualTypeOf<string>();
  expectTypeOf<CodexFailure["transcriptPath"]>().toEqualTypeOf<string>();
  expectTypeOf<UsageLimit["turnFailure"]["category"]>().toEqualTypeOf<"usage_limit">();
});

test("C-API-65 the bounded display preserves UTF-16 code units at the truncation point", () => {
  const head = `${"x".repeat(1_999)}\ud800`;
  expect(boundedDiagnostic(`${head}\udc00`)).toBe(`${head}…`);
});
