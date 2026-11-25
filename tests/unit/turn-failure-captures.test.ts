/**
 * Every failed turn captured from the real CLIs maps to the `turn_failure` PRD §5.4 specifies
 * (C-API-65). The unknown-model captures came from the real service; the rest came from
 * loopback stubs answering with billing, usage-limit, rate-limit, and server errors
 * (docs/cli-behavior.md, "Billing, usage-limit and rate-limit failures").
 */

import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { claudeTurnFailureActivity } from "../../src/claude/hooks/stop-failure.ts";
import { normalizeClaudeHookEvent } from "../../src/claude/normalize.ts";
import { codexTurnFailureActivity } from "../../src/codex/transcript/rejection.ts";
import { isRecord } from "../../src/core/predicates.ts";
import type { ElwoodTurnFailureCategory } from "../../src/index.ts";

const claudeShapes = [
  "unknown-model",
  "credit-balance-400",
  "payment-required-402",
  "rate-limit-429",
  "five-hour-limit-429",
] as const;
const codexShapes = [
  "unknown-model",
  "workspace-owner-credits",
  "workspace-member-credits",
  "usage-limit",
  "usage-limit-reset",
  "usage-not-included",
  "insufficient-quota-429",
  "insufficient-quota-stream",
  "payment-required-402",
  "rate-limit-429-retried",
  "server-error-500",
] as const;

/** `sourceRecord` is the raw CLI data: Claude's `StopFailure` hook body or Codex's rollout record. */
type Capture<Shape extends string> = { readonly shape: Shape; readonly sourceRecord: unknown };

/** Reads a capture file, checking each row's envelope instead of trusting a cast. */
function captures<const Shapes extends readonly string[]>(
  file: string,
  shapes: Shapes,
): Capture<Shapes[number]>[] {
  const text = readFileSync(new URL(`../fixtures/${file}`, import.meta.url), "utf8");
  return text
    .trim()
    .split("\n")
    .map((line): Capture<Shapes[number]> => {
      const row: unknown = JSON.parse(line);
      const shape = isRecord(row) ? row["shape"] : undefined;
      const known = shapes.find((candidate) => candidate === shape);
      if (!(isRecord(row) && known && typeof row["cause"] === "string" && "sourceRecord" in row)) {
        throw new Error(`${file} has a malformed capture row: ${line.slice(0, 80)}`);
      }
      return { shape: known, sourceRecord: row["sourceRecord"] };
    });
}

const expectedClaudeCategory: Readonly<
  Record<(typeof claudeShapes)[number], ElwoodTurnFailureCategory>
> = {
  "unknown-model": "model_unavailable",
  "credit-balance-400": "quota_or_credit",
  "payment-required-402": "unknown",
  "rate-limit-429": "rate_limited",
  "five-hour-limit-429": "rate_limited",
};

const expectedCodexCategory: Readonly<
  Record<(typeof codexShapes)[number], ElwoodTurnFailureCategory>
> = {
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
  const claude = captures("claude-2.1.332/turn-failures.jsonl", claudeShapes);
  const codex = captures("codex-0.172.0/turn-failures.jsonl", codexShapes);
  expect(claude.map(({ shape }) => shape)).toEqual(Object.keys(expectedClaudeCategory));
  expect(codex.map(({ shape }) => shape)).toEqual(Object.keys(expectedCodexCategory));
});

test.each(
  captures("claude-2.1.332/turn-failures.jsonl", claudeShapes),
)("C-API-65 a captured Claude 2.1.332 StopFailure ($shape) is a final turn_failure", ({
  shape,
  sourceRecord,
}) => {
  const hook = normalizeClaudeHookEvent(sourceRecord);
  if (hook.hook_event_name !== "StopFailure") throw new Error(`${shape} is not a StopFailure`);
  const category = expectedClaudeCategory[shape];
  expect(claudeTurnFailureActivity("s1", hook)).toEqual({
    elwoodSessionId: "s1",
    agent: "claude",
    source: "hook",
    kind: "turn_failure",
    label: category,
    // Claude sent no `error_details`, so §6.1 names its code; it never reads the rendered text.
    turnFailure: {
      category,
      message: `Claude rejected the turn: ${String(hook.error)}`,
      disposition: "final",
    },
    hookEventName: "StopFailure",
    turnId: hook["prompt_id"],
    transcriptPath: hook.transcript_path,
  });
});

test.each(
  captures("codex-0.172.0/turn-failures.jsonl", codexShapes),
)("C-API-65 a captured Codex 0.172.0 failed task_complete ($shape) is a final turn_failure", ({
  shape,
  sourceRecord,
}) => {
  const payload = isRecord(sourceRecord) ? sourceRecord["payload"] : undefined;
  const error = isRecord(payload) ? payload["error"] : undefined;
  if (!(isRecord(payload) && isRecord(error))) throw new Error(`${shape} is not a failed task`);
  const category = expectedCodexCategory[shape];
  // Codex writes a sentence, not the service's body, so no reset reaches the activity.
  expect(
    codexTurnFailureActivity({ elwoodSessionId: "s1", path: "/r", item: sourceRecord }),
  ).toEqual({
    elwoodSessionId: "s1",
    agent: "codex",
    source: "transcript",
    kind: "turn_failure",
    label: category,
    turnFailure: { category, message: error["message"], disposition: "final" },
    transcriptPath: "/r",
    turnId: payload["turn_id"],
  });
});
