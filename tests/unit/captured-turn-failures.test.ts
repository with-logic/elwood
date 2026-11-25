/**
 * Every failed turn captured from the real CLIs maps to the `turn_failure` PRD §5.4 specifies
 * (C-API-65). The captures came from loopback stubs answering with billing, usage-limit, and
 * rate-limit errors (docs/cli-behavior.md, "Billing, usage-limit and rate-limit failures").
 */

import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import type { StopFailureEvent } from "../../src/claude/hooks/events-extra.ts";
import { claudeTurnFailureActivity } from "../../src/claude/hooks/stop-failure.ts";
import { codexTurnFailureActivity } from "../../src/codex/transcript/rejection.ts";
import type { ElwoodTurnFailureCategory } from "../../src/index.ts";

type Capture = { readonly shape: string; readonly native: Record<string, unknown> };

function captures(file: string): Capture[] {
  const text = readFileSync(new URL(`../fixtures/${file}`, import.meta.url), "utf8");
  return text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Capture);
}

const claude: Readonly<Record<string, ElwoodTurnFailureCategory>> = {
  "unknown-model": "model_unavailable",
  "credit-balance-400": "quota_or_credit",
  "payment-required-402": "unknown",
  "rate-limit-429": "rate_limited",
  "five-hour-limit-429": "rate_limited",
};

const codex: Readonly<Record<string, ElwoodTurnFailureCategory>> = {
  "unknown-model": "model_unavailable",
  "workspace-owner-credits": "quota_or_credit",
  "workspace-member-credits": "quota_or_credit",
  "usage-limit": "usage_limit",
  "usage-limit-reset": "usage_limit",
  "usage-not-included": "usage_limit",
  "insufficient-quota-429": "usage_limit",
  "insufficient-quota-stream": "usage_limit",
  "payment-required-402": "network_or_api",
  "rate-limit-429-retried": "network_or_api",
  "server-error-500": "network_or_api",
};

test("every captured shape has an expected category, and every expected shape a capture", () => {
  const shapes = (file: string) => captures(file).map(({ shape }) => shape);
  expect(shapes("claude-2.1.332/turn-failures.jsonl")).toEqual(Object.keys(claude));
  expect(shapes("codex-0.172.0/turn-failures.jsonl")).toEqual(Object.keys(codex));
});

test.each(
  captures("claude-2.1.332/turn-failures.jsonl"),
)("C-API-65 a captured Claude 2.1.332 StopFailure ($shape) is a final turn_failure", ({
  shape,
  native,
}) => {
  const hook = native as StopFailureEvent;
  expect(claudeTurnFailureActivity("s1", hook)).toEqual({
    elwoodSessionId: "s1",
    agent: "claude",
    source: "hook",
    kind: "turn_failure",
    label: claude[shape],
    // Claude sent no `error_details`, so §6.1 names its code; it never reads the rendered text.
    turnFailure: {
      category: claude[shape],
      message: `Claude rejected the turn: ${String(hook.error)}`,
      disposition: "final",
    },
    hookEventName: "StopFailure",
    turnId: hook["prompt_id"],
    transcriptPath: hook.transcript_path,
  });
});

test.each(
  captures("codex-0.172.0/turn-failures.jsonl"),
)("C-API-65 a captured Codex 0.172.0 failed task_complete ($shape) is a final turn_failure", ({
  shape,
  native,
}) => {
  const failure = codexTurnFailureActivity({ elwoodSessionId: "s1", path: "/r", item: native });
  const payload = native["payload"] as Record<string, Record<string, unknown>>;
  // Codex writes a sentence, not the service's body, so no reset reaches the activity.
  expect(failure).toEqual({
    elwoodSessionId: "s1",
    agent: "codex",
    source: "transcript",
    kind: "turn_failure",
    label: codex[shape],
    turnFailure: {
      category: codex[shape],
      message: payload["error"]?.["message"],
      disposition: "final",
    },
    transcriptPath: "/r",
    turnId: payload["turn_id"],
  });
});
