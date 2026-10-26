/**
 * The bounds on reading the paths of processes that could be Codex's shared daemon (PRD
 * §5.3, C-LIFE-10): each is a `ps` of its own, so a table read runs at most
 * `PATH_READS_AT_ONCE` of them at once, and starts none past its deadline, failing as a
 * read that timed out does. Scripted tables and `ps` reads only.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import type { ProcessEntry, PsRunner } from "../../src/runtime/shutdown/process-table.ts";
import {
  daemonScope,
  listProcessTableMarkingDaemon,
  PATH_READS_AT_ONCE,
} from "../../src/runtime/shutdown/shared-daemon.ts";
import { hook, LEADER, leaderRow } from "../helpers/scripted-process-tree.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

const DAEMON = "/tmp/home/.codex/packages/app-server-daemon/releases/0.164.0/bin/codex";
/** Nine `codex` group leaders under the session's TUI, each of which could be the daemon. */
const candidates = Array.from({ length: 9 }, (_, i) => hook(5010 + i, { name: "codex" }));
const table: readonly ProcessEntry[] = [leaderRow, ...candidates];

/** A runner holding each read until `release`, counting the reads in flight at once. */
function heldRunner() {
  const started: number[] = [];
  const waiting: (() => void)[] = [];
  let inFlight = 0;
  let mostInFlight = 0;
  const run: PsRunner = (_file, args) => {
    started.push(Number(args.at(-1)));
    inFlight += 1;
    mostInFlight = Math.max(mostInFlight, inFlight);
    const { promise, resolve } = Promise.withResolvers<{ stdout: string }>();
    waiting.push(() => {
      inFlight -= 1;
      resolve({ stdout: `${DAEMON}\n` });
    });
    return promise;
  };
  const release = () => {
    for (const done of waiting.splice(0)) done();
  };
  return { run, started, release, mostInFlight: () => mostInFlight };
}

const marked = (rows: readonly ProcessEntry[]) =>
  rows.filter((row) => row.shared).map((row) => row.pid);

describe("C-LIFE-10 the daemon's path reads", () => {
  test("run at most four at once, until every process that could be one is read", async () => {
    const { run, started, release, mostInFlight } = heldRunner();
    const list = () => Promise.resolve(table);
    const marking = listProcessTableMarkingDaemon(3_000, daemonScope(new Set([LEADER])), list, run);
    for (const reads of [4, 8, 9]) {
      await vi.waitFor(() => expect(started).toHaveLength(reads));
      release();
    }
    expect(marked(await marking)).toEqual(candidates.map((row) => row.pid));
    expect(PATH_READS_AT_ONCE).toBe(4);
    expect(mostInFlight()).toBe(PATH_READS_AT_ONCE);
  });

  test("start none past the read's deadline, which fails the read as timed out", async () => {
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    const { run, started, release } = heldRunner();
    const list = () => Promise.resolve(table);
    const marking = listProcessTableMarkingDaemon(3_000, daemonScope(new Set([LEADER])), list, run);
    await vi.waitFor(() => expect(started).toHaveLength(4));
    clock = 3_000; // The first four took the rest of the deadline.
    release();
    await expect(marking).rejects.toMatchObject({ code: "ETIMEDOUT" });
    expect(started).toHaveLength(4);
  });

  test("a path read that runs out of time once started fails as timed out", async () => {
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    // `execFile` ends a run past its timeout with SIGKILL, and rejects with no errno code.
    const killed = Object.assign(new Error("Command failed"), { killed: true, signal: "SIGKILL" });
    const run: PsRunner = () => {
      clock = 3_000;
      return Promise.reject(killed);
    };
    const one = () => Promise.resolve([leaderRow, hook(5010, { name: "codex" })]);
    const scope = daemonScope(new Set([LEADER]));
    await expect(listProcessTableMarkingDaemon(3_000, scope, one, run)).rejects.toMatchObject({
      code: "ETIMEDOUT",
    });
  });

  test("a table read that took the whole deadline starts none", async () => {
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    const { run, started } = heldRunner();
    const slowList = () => {
      clock = 3_000;
      return Promise.resolve(table);
    };
    const scope = daemonScope(new Set([LEADER]));
    await expect(listProcessTableMarkingDaemon(3_000, scope, slowList, run)).rejects.toMatchObject({
      code: "ETIMEDOUT",
    });
    expect(started).toEqual([]);
  });
});
