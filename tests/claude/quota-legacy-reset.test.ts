/** Reset-label fixtures for the Claude /usage fallback (C-STATS-05). */
import { afterEach, expect, test, vi } from "vitest";
import { createLegacyResetReader } from "../../src/claude/usage/legacy-reset.ts";

afterEach(() => vi.useRealTimers());

test.each([
  ["Jan 1, 12am (UTC)", "2026-12-31T23:20:00Z", "2027-01-01T00:00:00.000Z"],
  ["Jan 1, 2027, 12am (UTC)", "2026-12-31T23:20:00Z", "2027-01-01T00:00:00.000Z"],
  ["Dec 31, 11pm (UTC)", "2027-01-01T00:20:00Z", "2026-12-31T23:00:00.000Z"],
  ["Jan 2, 12pm (UTC)", "2027-01-01T23:20:00Z", "2027-01-02T12:00:00.000Z"],
  ["Tomorrow", "2026-11-30T12:00:00Z", undefined],
  ["Nov 30, 6pm (Invalid/Zone)", "2026-11-30T12:00:00Z", undefined],
  ["Nov 31, 6pm (UTC)", "2026-11-30T12:00:00Z", undefined],
  ["Nov 1, 1:30am (America/Los_Angeles)", "2026-11-01T04:00:00Z", undefined],
  ["Mar 8, 2:30am (America/Los_Angeles)", "2026-03-08T04:00:00Z", undefined],
  ["Jun 2, 6pm (UTC)", "2026-11-30T12:00:00Z", undefined],
])("C-STATS-05 Claude preserves unambiguous legacy reset dates within eight days (%s)", (label, now, expected) => {
  vi.setSystemTime(new Date(now));
  expect(createLegacyResetReader()(label)).toEqual(expected);
});
