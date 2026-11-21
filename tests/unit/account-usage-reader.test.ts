/** Account cache lifetime and roster isolation (PRD §5.12, C-STATS-06). */
import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import { afterEach, expect, test, vi } from "vitest";
import { createAccountUsageReader, readAccountUsage } from "../../src/index.ts";
import {
  type CommandRunner,
  resetRuntimeSeamsForTests,
  setCommandRunnerForTests,
} from "../../src/runtime/seams.ts";

vi.mock(import("node:fs"), async (importOriginal) => ({
  ...(await importOriginal()),
  writeSync: vi.fn<(fd: number, data: string | NodeJS.ArrayBufferView) => number>(),
}));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  resetRuntimeSeamsForTests();
});

test.each([
  "",
  "stream,elwood",
])("C-STATS-05 fallback diagnostics stay opt-in (%s)", async (debug) => {
  vi.stubEnv("NODE_DEBUG", debug);
  const write = vi.mocked(fs.writeSync).mockImplementation(() => {
    throw new Error("closed pipe");
  });
  setCommandRunnerForTests(() => ({
    status: 0,
    stderr: "",
    stdout: "ELWOOD_QUOTA_FALLBACK\nprivate report",
  }));
  expect(await readAccountUsage([{ agent: "claude", label: "Test" }])).toMatchObject([
    { status: "unavailable" },
  ]);
  if (debug)
    expect(write).toHaveBeenCalledWith(
      2,
      "ELWOOD: Unrecognized Claude account usage fallback report.\n",
    );
  else expect(write).not.toHaveBeenCalled();
});

test("C-STATS-06 account readers share an in-flight roster and refresh each expired account", async () => {
  const start = new Date("2026-11-20T12:00:00Z");
  vi.setSystemTime(start);
  const run = vi.fn<CommandRunner>((_command, shellArgs) => {
    const command = shellArgs[3];
    assert.ok(command, "missing account probe shell script");
    const claude = command.includes(" 'claude'");
    return {
      status: 0,
      stdout: JSON.stringify(
        claude
          ? {
              rate_limits_available: true,
              rate_limits: {
                limits: [
                  {
                    kind: "session",
                    percent: 30,
                    resets_at: new Date(Date.now() + 120_000).toISOString(),
                  },
                ],
              },
            }
          : { rateLimits: { primary: { usedPercent: 20 } } },
      ),
      stderr: "",
    };
  });
  setCommandRunnerForTests(run);
  const accounts = [
    { agent: "claude" as const, label: "Work" },
    { agent: "codex" as const, label: "Personal" },
  ];
  const read = createAccountUsageReader(accounts);
  accounts[0]!.label = "Changed";
  const [first, simultaneous] = await Promise.all([read(), read()]);
  expect(run).toHaveBeenCalledTimes(2);
  expect(first).toEqual(simultaneous);
  expect(first).toMatchObject([
    { label: "Work", status: "available", windows: [{ usedPercent: 30 }] },
    { label: "Personal", status: "available", windows: [{ usedPercent: 20 }] },
  ]);
  Object.assign(first[0]!.windows[0]!, { usedPercent: 99 });
  expect((await read())[0]?.windows[0]?.usedPercent).toBe(30);
  vi.setSystemTime(new Date(start.getTime() + 120_000));
  const afterReset = await read();
  expect(run).toHaveBeenCalledTimes(3);
  expect(afterReset[0]?.checkedAt).not.toBe(first[0]?.checkedAt);
  expect(afterReset[1]).toEqual(first[1]);
  vi.setSystemTime(new Date(start.getTime() + 300_000));
  expect((await read())[1]?.checkedAt).not.toBe(first[1]?.checkedAt);
  expect(run).toHaveBeenCalledTimes(5);
  await readAccountUsage(accounts);
  expect(run).toHaveBeenCalledTimes(7);
});

test("C-STATS-06 a reset cannot start another probe during an outstanding roster read", async () => {
  const time = new Date("2026-11-20T12:00:00Z");
  vi.setSystemTime(time);
  const slow = Promise.withResolvers<Awaited<ReturnType<CommandRunner>>>();
  const ready = {
    status: 0,
    stdout: JSON.stringify({
      rateLimits: { primary: { usedPercent: 20, resetsAt: time.getTime() / 1000 + 1 } },
    }),
    stderr: "",
  };
  const run = vi
    .fn<CommandRunner>()
    .mockImplementationOnce(() => slow.promise)
    .mockResolvedValue(ready);
  setCommandRunnerForTests(run);
  const read = createAccountUsageReader();
  const first = read();
  await new Promise<void>((resolve) => setImmediate(resolve));
  vi.setSystemTime(new Date(time.getTime() + 1000));
  const second = read();
  slow.resolve({ status: 1, stdout: "", stderr: "" });
  expect(await first).toEqual(await second);
  expect(run).toHaveBeenCalledTimes(2);
});

test("C-STATS-06 backward system clock adjustments cannot extend an account reading", async () => {
  const elapsed = vi.spyOn(performance, "now").mockReturnValue(0);
  vi.setSystemTime(new Date("2026-11-20T12:00:00Z"));
  const run = vi.fn<CommandRunner>().mockResolvedValue({ status: 1, stdout: "", stderr: "" });
  setCommandRunnerForTests(run);
  try {
    const read = createAccountUsageReader([{ agent: "codex", label: "Test" }]);
    await read();
    vi.setSystemTime(new Date("2026-11-20T11:55:00Z"));
    elapsed.mockReturnValue(300_000);
    await read();
    expect(run).toHaveBeenCalledTimes(2);
  } finally {
    elapsed.mockRestore();
  }
});

test("C-STATS-05 fallback exit diagnostics distinguish failure from cancellation", async () => {
  vi.stubEnv("NODE_DEBUG", "elwood");
  const write = vi.mocked(fs.writeSync).mockReturnValue(0);
  const failed = { status: 1, stdout: "ELWOOD_QUOTA_FALLBACK\nprivate report", stderr: "" };
  const run = vi
    .fn<CommandRunner>()
    .mockResolvedValueOnce(failed)
    .mockResolvedValueOnce({
      ...failed,
      error: { code: "ABORT_ERR", message: "Canceled" },
    });
  setCommandRunnerForTests(run);
  const profiles = [{ agent: "claude" as const, label: "Test" }];
  await readAccountUsage(profiles);
  await readAccountUsage(profiles);
  expect(write).toHaveBeenCalledExactlyOnceWith(
    2,
    "ELWOOD: Claude account usage fallback failed.\n",
  );
});

test("C-STATS-06 account readers validate a roster and bound retries on unavailable profiles", async () => {
  expect(() => createAccountUsageReader([{ agent: "codex", label: "" }])).toThrow(TypeError);
  const run = vi.fn<CommandRunner>().mockResolvedValue({ status: 1, stdout: "", stderr: "" });
  setCommandRunnerForTests(run);
  const read = createAccountUsageReader();
  expect(await read()).toMatchObject([{ status: "unavailable" }, { status: "unavailable" }]);
  await read();
  expect(run).toHaveBeenCalledTimes(2);
});
