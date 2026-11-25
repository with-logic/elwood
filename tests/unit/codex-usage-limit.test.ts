/** Codex quota hits require a native reached type in a committed token_count (PRD §5.12). */
import { expect, test } from "vitest";
import { CodexUsageLimitObserver } from "../../src/codex/transcript/usage-limit.ts";

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
  "rate_limit_reached",
  "workspace_owner_credits_depleted",
  "workspace_member_credits_depleted",
  "workspace_owner_usage_limit_reached",
  "workspace_member_usage_limit_reached",
])("reports exact subtype %s without any quota windows or scope metadata", (reachedType) => {
  expect(
    new CodexUsageLimitObserver().observe(tokenCount({ rate_limit_reached_type: reachedType })),
  ).toEqual({ reachedType });
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
  expect(
    observer.observe(
      tokenCount({
        ...hit,
        primary: { resets_at: 1_795_700_000 },
      }),
    ),
  ).toMatchObject({ primaryResetsAtUnixSeconds: 1_795_700_000 });
  expect(
    observer.observe(
      tokenCount({
        ...hit,
        rate_limit_reached_type: "workspace_member_usage_limit_reached",
      }),
    ),
  ).toMatchObject({ reachedType: "workspace_member_usage_limit_reached" });
  expect(observer.observe(tokenCount({ ...hit, limit_id: "codex_other" }))).toMatchObject({
    limitId: "codex_other",
  });
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
