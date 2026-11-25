/** Codex quota hits require a native reached type in a committed token_count (PRD §5.4, C-API-69). */
import { expect, test } from "vitest";
import {
  CodexUsageLimitObserver,
  codexUsageLimitWarning,
} from "../../src/codex/transcript/usage-limit.ts";

function tokenCount(rateLimits: unknown) {
  return {
    type: "event_msg",
    payload: { type: "token_count", info: null, rate_limits: rateLimits },
  };
}

const hit = {
  limit_id: "codex",
  limit_name: "Codex",
  rate_limit_reached_type: "rate_limit_reached",
  primary: { used_percent: 100, resets_at: 1_795_619_478 },
  secondary: { used_percent: 20, resets_at: 1_795_668_000 },
};

test("preserves the native limit and each window's reset independently", () => {
  const observe = new CodexUsageLimitObserver();
  expect(observe.observe(tokenCount(hit))).toEqual({
    reachedType: "rate_limit_reached",
    limitId: "codex",
    limitName: "Codex",
    primaryResetsAtUnixSeconds: 1_795_619_478,
    secondaryResetsAtUnixSeconds: 1_795_668_000,
  });
});

test.each([
  ["rate_limit_reached", "Codex reached its rate limit."],
  ["workspace_owner_credits_depleted", "The Codex workspace owner is out of credits."],
  ["workspace_member_credits_depleted", "The Codex workspace member is out of credits."],
  ["workspace_owner_usage_limit_reached", "The Codex workspace owner reached a usage limit."],
  ["workspace_member_usage_limit_reached", "The Codex workspace member reached a usage limit."],
] as const)("reports subtype %s and its message without quota windows", (reachedType, message) => {
  const item = tokenCount({ rate_limit_reached_type: reachedType });
  const observation = new CodexUsageLimitObserver().observe(item);
  expect(observation).toEqual({ reachedType });
  const warning = codexUsageLimitWarning(
    {
      elwoodSessionId: "session",
      path: "/rollout.jsonl",
      item,
      summary: { kind: "other", label: "token_count" },
    },
    { reachedType },
  );
  expect(warning).toMatchObject({ nativeLimitType: reachedType, raw: reachedType, message });
});

test("accepts a numeric reset without utilization and omits malformed optional metadata", () => {
  const observe = new CodexUsageLimitObserver();
  expect(
    observe.observe(
      tokenCount({
        ...hit,
        limit_id: "  ",
        limit_name: "x".repeat(2_000),
        primary: { resets_at: 0 },
        secondary: { resets_at: Number.MAX_SAFE_INTEGER + 1 },
      }),
    ),
  ).toEqual({ reachedType: "rate_limit_reached", primaryResetsAtUnixSeconds: 0 });
  expect(
    observe.observe(
      tokenCount({
        ...hit,
        limit_id: 5,
        limit_name: null,
        primary: [],
        secondary: { resets_at: "1795668000" },
      }),
    ),
  ).toEqual({ reachedType: "rate_limit_reached" });
});

test.each([
  undefined,
  null,
  7,
  "future_limit",
  "__proto__",
])("ignores %s without interpreting percentages as an explicit rejection", (rate_limit_reached_type) => {
  expect(
    new CodexUsageLimitObserver().observe(tokenCount({ ...hit, rate_limit_reached_type })),
  ).toBeUndefined();
});

test.each([
  undefined,
  [],
  { type: "response_item", payload: tokenCount(hit).payload },
  { type: "event_msg", payload: null },
  { type: "event_msg", payload: { type: "task_complete", rate_limits: hit } },
  tokenCount([]),
  tokenCount(null),
])("ignores non-token-count or malformed record %#", (item) => {
  expect(new CodexUsageLimitObserver().observe(item)).toBeUndefined();
});

test("suppresses copies despite unrelated token, timing or utilization changes", () => {
  const observer = new CodexUsageLimitObserver();
  expect(observer.observe(tokenCount(hit))).toBeDefined();
  expect(
    observer.observe({
      ...tokenCount({ ...hit, primary: { ...hit.primary, used_percent: 104 } }),
      timestamp: "2026-11-25T12:00:00.000Z",
    }),
  ).toBeUndefined();
  expect(observer.observe(tokenCount(hit))).toBeUndefined();
});

test.each([
  [
    "primary reset",
    { primary: { ...hit.primary, resets_at: 1_795_700_000 } },
    { primaryResetsAtUnixSeconds: 1_795_700_000 },
  ],
  [
    "secondary reset",
    { secondary: { ...hit.secondary, resets_at: 1_795_701_000 } },
    { secondaryResetsAtUnixSeconds: 1_795_701_000 },
  ],
  [
    "rejection reason",
    { rate_limit_reached_type: "workspace_member_usage_limit_reached" },
    { reachedType: "workspace_member_usage_limit_reached" },
  ],
  ["limit ID", { limit_id: "codex_other" }, { limitId: "codex_other" }],
  ["limit name", { limit_name: "Other" }, { limitName: "Other" }],
])("reports a change to only the %s once", (_field, change, expected) => {
  const observer = new CodexUsageLimitObserver();
  const initial = observer.observe(tokenCount(hit));
  expect(initial).toBeDefined();
  const changed = tokenCount({ ...hit, ...change });
  expect(observer.observe(changed)).toEqual({ ...initial, ...expected });
  expect(observer.observe(changed)).toBeUndefined();
});

test("clears only on an explicit subsequent nonrejected snapshot for the same limit ID", () => {
  const observer = new CodexUsageLimitObserver();
  const clear = { limit_id: "codex", rate_limit_reached_type: null };
  expect(observer.observe(tokenCount(clear))).toBeUndefined();
  expect(observer.observe(tokenCount(hit))).toBeDefined();
  expect(observer.observe(tokenCount(null))).toBeUndefined();
  expect(observer.observe(tokenCount({ limit_id: "codex" }))).toBeUndefined();
  expect(
    observer.observe(tokenCount({ ...clear, rate_limit_reached_type: "future_limit" })),
  ).toBeUndefined();
  expect(observer.observe(tokenCount({ ...clear, limit_id: "codex_other" }))).toBeUndefined();
  expect(observer.observe(tokenCount({ rate_limit_reached_type: null }))).toBeUndefined();
  expect(observer.observe(tokenCount(hit))).toBeUndefined();
  expect(observer.observe(tokenCount(clear))).toBeUndefined();
  expect(observer.observe(tokenCount(hit))).toBeDefined();
});

test("preserves IDs and names at the inclusive 256 UTF-16 code-unit limit", () => {
  const observer = new CodexUsageLimitObserver();
  const limitId = "x".repeat(256);
  const limitName = "🧪".repeat(128);
  expect(
    observer.observe(tokenCount({ ...hit, limit_id: limitId, limit_name: limitName })),
  ).toMatchObject({ limitId, limitName });
  expect(
    observer.observe(tokenCount({ ...hit, limit_id: `${limitId}x`, limit_name: `${limitName}x` })),
  ).toEqual({
    reachedType: "rate_limit_reached",
    primaryResetsAtUnixSeconds: 1_795_619_478,
    secondaryResetsAtUnixSeconds: 1_795_668_000,
  });
});

test("deduplicates distinct overlength IDs without publishing them", () => {
  const observer = new CodexUsageLimitObserver();
  const base = "x".repeat(256);
  const first = tokenCount({ ...hit, limit_id: `${base}1` });
  const second = tokenCount({ ...hit, limit_id: `${base}2` });
  expect(observer.observe(first)).toMatchObject({ reachedType: "rate_limit_reached" });
  const result = observer.observe(second);
  expect(result).toMatchObject({ reachedType: "rate_limit_reached" });
  expect(result).not.toHaveProperty("limitId");
  expect(observer.observe(second)).toBeUndefined();
  expect(
    observer.observe(
      tokenCount({
        limit_id: `${base}2`,
        rate_limit_reached_type: null,
      }),
    ),
  ).toBeUndefined();
  expect(observer.observe(second)).toBeDefined();
});
