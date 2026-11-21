/** Parse Claude's isolated usage response without exposing raw frames (C-STATS-05). */
import { expect, test, vi } from "vitest";
import { claudeFallbackWindows } from "../../src/claude/usage/fallback.ts";

const header = "You are currently using your subscription to power your Claude Code usage";
const report = [
  header,
  "Current session: 18.5% used · resets Nov 20, 6am (America/Los_Angeles)",
  "Current week (all models): 54% used · resets Nov 22, 7:45pm (America/Los_Angeles)",
  "Current week (Opus): 21% used",
].join("\n");

function assistant(content: unknown, usageReport?: unknown) {
  return JSON.stringify({ type: "assistant", message: { content }, usage_report: usageReport });
}

test("C-STATS-05 reads scoped legacy windows and ignores unrelated frames", () => {
  vi.setSystemTime(new Date("2026-11-20T12:00:00Z"));
  try {
    const windows = claudeFallbackWindows(
      [
        "shell noise",
        '{"type":"system"}',
        assistant(null),
        assistant([null, { type: "other" }, { type: "text", text: 0 }]),
        assistant([{ type: "text", text: "Current week: 7% used" }]),
        assistant([{ type: "text", text: report }]),
        assistant([{ type: "text", text: `${header}\nCurrent week: 99% used` }]),
      ].join("\n"),
    );
    expect(windows).toEqual([
      {
        label: "5-hour",
        usedPercent: 18.5,
        remainingPercent: 81.5,
        windowMinutes: 300,
        resetsAt: "2026-11-20T14:00:00.000Z",
      },
      {
        label: "Weekly",
        usedPercent: 54,
        remainingPercent: 46,
        windowMinutes: 10_080,
        resetsAt: "2026-11-23T03:45:00.000Z",
      },
      { label: "Weekly (Opus)", usedPercent: 21, remainingPercent: 79, windowMinutes: 10_080 },
    ]);
  } finally {
    vi.useRealTimers();
  }
});

test("C-STATS-05 a structured fallback report takes precedence over older text", () => {
  const legacy = assistant([{ type: "text", text: report }]);
  expect(claudeFallbackWindows(`${legacy}\n${assistant([], null)}`)).toEqual([]);
  expect(
    claudeFallbackWindows(
      `${legacy}\n${assistant([], {
        rate_limits: {
          limits: [{ kind: "session", percent: 14 }],
        },
      })}`,
    ),
  ).toEqual([{ label: "5-hour", usedPercent: 14, remainingPercent: 86, windowMinutes: 300 }]);
});

test("C-STATS-05 an overage report can provide text windows when its structured twin has no limits", () => {
  const overage = "You are currently using your overages to power your Claude Code usage.";
  const frame = assistant([{ type: "text", text: `${overage}\nCurrent week: 9% used` }], {
    rate_limits: { limits: null },
  });
  expect(claudeFallbackWindows(frame)).toEqual([
    { label: "Weekly", usedPercent: 9, remainingPercent: 91, windowMinutes: 10_080 },
  ]);
});

test("C-STATS-05 legacy rows reuse one formatter per reported time zone", () => {
  vi.setSystemTime(new Date("2026-11-20T12:00:00Z"));
  const NativeFormatter = Intl.DateTimeFormat;
  const format = vi
    .spyOn(Intl, "DateTimeFormat")
    .mockImplementation((locales, options) => new NativeFormatter(locales, options));
  try {
    const row = "Current session: 3% used · resets Nov 20, 1pm (UTC)";
    const text = [header, ...new Array<string>(100).fill(row)].join("\n");
    expect(claudeFallbackWindows(assistant([{ type: "text", text }]))).toHaveLength(100);
    expect(format).toHaveBeenCalledTimes(1);
  } finally {
    format.mockRestore();
    vi.useRealTimers();
  }
});
