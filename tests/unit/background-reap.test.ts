/**
 * The background reap of what a failed walk recorded (PRD §5.3, C-LIFE-14): the walk is
 * never retried from the leader's pid; the processes it recorded, by pid and start time,
 * are reaped until a read shows them gone, and only then does a later call stop
 * rejecting. Injected process operations only: every signal is logged, none is sent.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import {
  BACKGROUND_REAP_LIFETIME_MS,
  BACKGROUND_REAP_RETRY_MS,
} from "../../src/runtime/shutdown/detached-sweep/background.ts";
import type { ProcessEntry } from "../../src/runtime/shutdown/process-table.ts";
import { SessionReaper } from "../../src/runtime/shutdown/reap-tree.ts";
import {
  errno,
  hook,
  LEADER,
  leaderNeverExits,
  leaderRow,
  scripted,
} from "../helpers/scripted-process-tree.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

/** A setsid hook (5002) and its child (5003) in its group, as the walk's first read shows. */
const tree = [leaderRow, hook(5002), hook(5003, { ppid: 5002, pgid: 5002 })];
/** The same two once the leader's SIGKILL left the hook under PID 1. */
const orphaned = [hook(5002, { ppid: 1 }), hook(5003, { ppid: 5002, pgid: 5002 })];

/** Whether read number `read`, bounded by `timeoutMs`, fails. */
type ReadFails = (read: number, timeoutMs: number) => boolean;

/**
 * A reaper whose walk reads `first`, then fails its next read, as a read past a loaded
 * host's deadline does; every read after that serves `later`, given the calls so far,
 * unless `fails` says it fails too.
 */
function failingWalk(
  first: readonly ProcessEntry[],
  later: (calls: readonly string[]) => readonly ProcessEntry[],
  fails: ReadFails = (read) => read === 2,
) {
  const { ops, calls, asRead } = scripted([]);
  let reads = 0;
  const listProcesses = (timeoutMs: number) => {
    reads += 1;
    calls.push("list");
    if (fails(reads, timeoutMs)) return Promise.reject(errno("ETIMEDOUT"));
    return Promise.resolve(asRead(reads === 1 ? first : later(calls)));
  };
  return { reaper: new SessionReaper(LEADER, { ...ops, listProcesses }), calls };
}

/** Serves `orphaned` until the hook's group is killed, and nothing after. */
const goneOnceKilled = (sent: readonly string[]) => (sent.includes("kill 5002") ? [] : orphaned);

const retry = (reaper: SessionReaper) => () => reaper.reapAndThrowOnDetachedSweepFailure();
/** The signals sent to anything but the leader's group, which the walk and group reap own. */
const beyondLeader = (calls: readonly string[]) =>
  calls.filter((call) => call !== "list" && !call.endsWith(` ${LEADER}`));
const UNREADABLE = /process table unreadable/;
/** How long a read on a loaded host can take: longer than one second. */
const SLOW_READ_MS = 1_200;

describe("C-LIFE-14 a failed walk's recorded processes", () => {
  test("are reaped in the background, and a later call resolves once a read shows them gone", async () => {
    const { reaper, calls } = failingWalk(tree, goneOnceKilled);
    await expect(reaper.sweepDetached(leaderNeverExits)).rejects.toThrow(UNREADABLE);
    expect(retry(reaper)).toThrow(UNREADABLE);
    await vi.waitFor(() => expect(retry(reaper)).not.toThrow(), { timeout: 5_000 });
    // Stopped as a recorded process's group, held over two reads, then killed.
    expect(beyondLeader(calls)).toEqual(["stop 5002", "kill 5002"]);
  });

  test("keep reaping after an attempt's read fails, which shows nothing gone", async () => {
    // Read 3 is the first attempt's: a failure there must not resolve, nor end the reap.
    const fails: ReadFails = (read) => read === 2 || read === 3;
    const { reaper, calls } = failingWalk(tree, goneOnceKilled, fails);
    await expect(reaper.sweepDetached(leaderNeverExits)).rejects.toThrow(UNREADABLE);
    await vi.waitFor(() => expect(retry(reaper)).not.toThrow(), { timeout: 5_000 });
    expect(beyondLeader(calls)).toEqual(["stop 5002", "kill 5002"]);
  });

  test("give each attempt's read the walk's deadline, so reads over a second still resolve", async () => {
    // Every read takes 1.2 s, as on a loaded host: one bounded below that times out.
    const fails: ReadFails = (read, timeoutMs) => read === 2 || timeoutMs < SLOW_READ_MS;
    const { reaper, calls } = failingWalk(tree, goneOnceKilled, fails);
    await expect(reaper.sweepDetached(leaderNeverExits)).rejects.toThrow(UNREADABLE);
    await vi.waitFor(() => expect(retry(reaper)).not.toThrow(), { timeout: 5_000 });
    expect(beyondLeader(calls)).toEqual(["stop 5002", "kill 5002"]);
  });

  test("never signal a recorded pid that a process started at another time now holds", async () => {
    const reused = hook(5002, { ppid: 1, startedAt: "Sun Oct 25 23:59:00 2026" });
    const { reaper, calls } = failingWalk(tree, () => [reused]);
    await expect(reaper.sweepDetached(leaderNeverExits)).rejects.toThrow(UNREADABLE);
    // The recorded hook and its child are gone; the reuse is not them, so that resolves.
    await vi.waitFor(() => expect(retry(reaper)).not.toThrow(), { timeout: 5_000 });
    expect(beyondLeader(calls)).toEqual([]);
  });

  test("keep a failure that recorded none rejecting, with no read after it", async () => {
    const { reaper, calls } = failingWalk([leaderRow], () => orphaned);
    await expect(reaper.sweepDetached(leaderNeverExits)).rejects.toThrow(UNREADABLE);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(retry(reaper)).toThrow(UNREADABLE);
    expect(calls.filter((call) => call === "list")).toHaveLength(2);
  });

  test("stop being reaped once the lifetime ends, still rejecting", async () => {
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    const { reaper, calls } = failingWalk(tree, () => {
      clock += BACKGROUND_REAP_LIFETIME_MS; // This read takes the whole lifetime.
      return orphaned;
    });
    await expect(reaper.sweepDetached(leaderNeverExits)).rejects.toThrow(UNREADABLE);
    await new Promise((resolve) => setTimeout(resolve, BACKGROUND_REAP_RETRY_MS * 1.5));
    expect(calls.filter((call) => call === "list")).toHaveLength(3);
    expect(beyondLeader(calls)).toEqual([]);
    expect(retry(reaper)).toThrow(UNREADABLE);
  });
});
