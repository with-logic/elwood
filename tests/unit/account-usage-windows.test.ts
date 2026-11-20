/** Native account limits and valid dates for C-STATS-01/03. */
import { expect, test } from "vitest";
import { claudeWindows } from "../../src/claude/usage/windows.ts";
import { codexStats } from "../../src/codex/transcript/stats.ts";
import { codexWindows } from "../../src/codex/usage/windows.ts";
import { isoInstant, resetFromSeconds, windowReadings } from "../../src/core/usage/windows.ts";

const reset = "2028-02-29T19:00:00+02:30";
const window = (label: string, windowMinutes?: number) => ({
  ...(windowMinutes === undefined ? {} : { windowMinutes }),
  label,
  usedPercent: 34.5,
  remainingPercent: 65.5,
  resetsAt: reset,
});
function claude(limits: object) {
  return claudeWindows({ rate_limits_available: true, rate_limits: limits });
}

test("C-STATS-03 Claude reports each active window with its model and surface labels", () => {
  const base = { percent: 34.5, resets_at: reset };
  expect(
    claude({
      limits: [
        { ...base, kind: "session", group: "session" },
        { ...base, kind: "weekly_all", group: "weekly", scope: {} },
        {
          ...base,
          kind: "weekly_scoped",
          group: "weekly",
          scope: { model: { display_name: "Fable" }, surface: { display_name: "Code" } },
        },
        { ...base, kind: "New limit", group: "other" },
        null,
        { group: "weekly" },
      ],
    }),
  ).toEqual([
    window("5-hour", 300),
    window("Weekly", 10080),
    window("Weekly (Fable / Code)", 10080),
    window("New limit"),
  ]);
  // Explicit server rows supersede any legacy fields.
  expect(claude({ limits: [], five_hour: { utilization: 9 } })).toEqual([]);
});

test.each([
  null,
  {},
  { rate_limits_available: true },
])("C-STATS-03 omits missing Claude limits for %j", (reply) => {
  expect(claudeWindows(reply)).toEqual([]);
});

test("C-STATS-03 Claude legacy windows preserve updates, omit missing limits, and deduplicate scoped buckets", () => {
  const row = { utilization: 34.5, resets_at: reset };
  expect(
    claude({
      seven_day: row,
      seven_day_opus: row,
      model_scoped: [null, {}, { ...row, display_name: "Opus" }, { ...row, display_name: "Fable" }],
    }),
  ).toEqual(["Weekly", "Weekly (Opus)", "Weekly (Fable)"].map((label) => window(label, 10080)));
  expect(claude({ five_hour: { utilization: 0 } })).toEqual([
    { label: "5-hour", windowMinutes: 300, usedPercent: 0, remainingPercent: 100 },
  ]);
});

test("C-STATS-03 Codex renders every rate-limit bucket once and labels each reported duration", () => {
  const primary = { usedPercent: 100, windowDurationMins: 300, resetsAt: 1 };
  const secondary = { usedPercent: 104, windowDurationMins: 10080 };
  const bucket = { primary, secondary };
  expect(
    codexWindows({
      rateLimits: bucket,
      rateLimitsByLimitId: {
        codex: bucket,
        fast: { secondary: { usedPercent: 0, windowDurationMins: 45 } },
      },
    }),
  ).toEqual([
    {
      label: "5-hour (codex)",
      windowMinutes: 300,
      usedPercent: 100,
      remainingPercent: 0,
      resetsAt: "1970-01-01T00:00:01.000Z",
    },
    { label: "Weekly (codex)", windowMinutes: 10080, usedPercent: 104, remainingPercent: 0 },
    { label: "45-minute (fast)", windowMinutes: 45, usedPercent: 0, remainingPercent: 100 },
  ]);
  expect(
    codexWindows({
      rateLimitsByLimitId: {},
      rateLimits: { limitId: "x", primary: { usedPercent: 24, windowDurationMins: 0 } },
    })[0]?.label,
  ).toBe("primary (x)");
  expect(codexWindows({ rateLimits: { primary: { usedPercent: 10 } } })[0]?.label).toBe("primary");
  expect(codexWindows({ rateLimitsByLimitId: { codex: null } })).toEqual([]);
  expect(codexWindows(null)).toEqual([]);
});

test("C-STATS-01 omits recordedAt for an invalid transcript timestamp", () => {
  const timestamp = "2026-02-30T12:00:00Z";
  const stats = codexStats({
    type: "event_msg",
    timestamp,
    payload: { type: "token_count", rate_limits: { primary: { used_percent: 4 } } },
  });
  expect(stats?.rateLimits).not.toHaveProperty("recordedAt");
  expect(isoInstant(reset)).toBe(reset);
  expect(resetFromSeconds(8_640_000_000_001)).toBeUndefined();
});

test.each([
  undefined,
  "tomorrow",
  "2026-14-01T12:00:00Z",
  "2026-02-30T12:00:00Z",
])("C-STATS-01 rejects invalid timestamp %s", (value) => expect(isoInstant(value)).toBeUndefined());

test.each([-1, Number.NaN])("C-STATS-03 omits invalid percentage %s", (usedPercent) => {
  expect(windowReadings("test", usedPercent, undefined)).toEqual([]);
});
