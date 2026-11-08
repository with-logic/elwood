/** A raced survivor STOP retains unknown restoration after identity replacement (C-LIFE-10). */
import { afterEach, expect, test, vi } from "vitest";
import { BACKGROUND_REAP_RETRY_WINDOW_MS } from "../../src/runtime/shutdown/detached-sweep/background.ts";
import { DescendantRecord } from "../../src/runtime/shutdown/detached-sweep/record.ts";
import { RetainedShutdownFailures } from "../../src/runtime/shutdown/detached-sweep/retained-failures.ts";
import { reapRecordedSurvivors } from "../../src/runtime/shutdown/detached-sweep/survivors.ts";
import { serializedReapQueue } from "../helpers/reap-queue.ts";
import {
  hook,
  LEADER,
  leaderRow,
  scripted,
  useScriptedHost,
} from "../helpers/scripted-process-tree.ts";

useScriptedHost();
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function retainedOutcome(failures: RetainedShutdownFailures): unknown {
  try {
    failures.throwIfUnresolved();
    return "resolved";
  } catch (error) {
    return error;
  }
}

test("C-LIFE-10 lost original members after raced STOP cannot be healed by empty recovery scans", async () => {
  vi.useFakeTimers();
  let clock = 0;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  const child = hook(5002, { ppid: 1 });
  const replacement = { ...child, startedAt: "Sun Oct 25 22:01:00 2026" };
  const record = new DescendantRecord();
  const observedAt = Date.parse("2026-10-26T00:00:00.000Z");
  record.observeFirst([leaderRow], LEADER, observedAt);
  record.observe([leaderRow, { ...child, ppid: LEADER }], LEADER, observedAt);
  let originalPresent = true;
  let replacementWasStopped = false;
  const fake = scripted([], {
    stopGroup: (group) => {
      // The recorded helper exits and its PGID is reused between the read and STOP.
      originalPresent = false;
      fake.calls.push(`stop ${group}`);
    },
    listProcesses: () => {
      const table = fake.asRead([originalPresent ? child : replacement]);
      replacementWasStopped ||= !originalPresent && table[0]!.stopped;
      return Promise.resolve(table);
    },
  });
  const failure = await reapRecordedSurvivors(record, fake.ops);
  expect(failure).toMatchObject({
    message: expect.stringContaining("a survivor group could not be safely confirmed stopped"),
  });
  const foreground = vi.fn(() => Promise.resolve([]));
  const failures = new RetainedShutdownFailures(
    {
      ...fake.ops,
      listProcesses: foreground,
      listProcessesUnreferenced: () => Promise.resolve([{ ...replacement, stopped: true }]),
    },
    serializedReapQueue(),
  );
  expect(() => failures.keep(failure, record)).toThrow();
  await vi.advanceTimersByTimeAsync(0);
  const outcomes = [retainedOutcome(failures)];
  clock = BACKGROUND_REAP_RETRY_WINDOW_MS;
  await failures.confirm();
  outcomes.push(retainedOutcome(failures));
  await failures.confirm();
  outcomes.push(retainedOutcome(failures));
  expect({
    replacementWasStopped,
    unknownRestoration: record.hasUnknownResume,
    outcomes,
    restorationPids: record.resumes.pids,
    signals: fake.calls,
    emptyConfirmationReads: foreground.mock.calls.length,
  }).toEqual({
    replacementWasStopped: true,
    unknownRestoration: true,
    outcomes: [failure, failure, failure],
    restorationPids: [],
    signals: ["stop 5002"],
    emptyConfirmationReads: 2,
  });
});
