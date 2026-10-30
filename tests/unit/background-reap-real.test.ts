/**
 * The background reap against real processes (PRD §5.3, C-LIFE-14). A `kill` whose walk
 * reads its tree once and then cannot read the table again rejects with a setsid hook and
 * its setsid child still running, under PID 1 once the leader is killed. Reaped in the
 * background by pid and start time, with real reads and signals, both end, and a later
 * call resolves. A host left with nothing but that reap to do exits at once, whether the
 * reap is reading or waiting for its next attempt.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { BACKGROUND_REAP_RETRY_MS } from "../../src/runtime/shutdown/detached-sweep/background.ts";
import { listProcessTable } from "../../src/runtime/shutdown/process-table.ts";
import { osProcessTreeOps, SessionReaper } from "../../src/runtime/shutdown/reap-tree.ts";
import { terminatePty } from "../../src/runtime/shutdown/terminate.ts";
import { runFileUnreferenced } from "../../src/runtime/shutdown/unreferenced-read.ts";
import { detachedDescendantPids, startDetachedTree } from "../helpers/detached-tree.ts";
import { pollGone } from "../helpers/process-liveness.ts";
import { startBystander, stopBystander } from "../helpers/setsid-pair.ts";

const SHUTDOWN = resolve(import.meta.dirname, "../../src/runtime/shutdown");

describe("C-LIFE-14 the background reap on real processes", () => {
  test("ends what a failed walk recorded, and a later call resolves", async () => {
    const tree = startDetachedTree();
    const [child, grandchild] = await detachedDescendantPids(tree);
    // A second-resolution identity must already be older than its start second when recorded.
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    let walkReads = 0;
    // The walk's first read succeeds, and every later one fails, as past a deadline.
    const listProcesses: typeof osProcessTreeOps.listProcesses = (timeoutMs, scope) => {
      walkReads += 1;
      if (walkReads === 1) return osProcessTreeOps.listProcesses(timeoutMs, scope);
      return Promise.reject(Object.assign(new Error("read timed out"), { code: "ETIMEDOUT" }));
    };
    const reaper = new SessionReaper(tree.pty.pid, { ...osProcessTreeOps, listProcesses });
    const kill = terminatePty(tree.pty, "SIGKILL", reaper);
    await expect(kill).rejects.toThrow("could not be confirmed reaped");
    expect(await pollGone({ pid: child, timeoutMs: 15_000 })).toBe(true);
    expect(await pollGone({ pid: grandchild, timeoutMs: 15_000 })).toBe(true);
    const retry = () => reaper.reapAndThrowOnDetachedSweepFailure();
    await vi.waitFor(() => expect(retry).not.toThrow(), { timeout: 10_000 });
  }, 60_000);

  test("a host whose only work left is a background reap exits at once", async () => {
    // A recorded process the reap can never end: its signals go nowhere.
    const recorded = startBystander();
    let host: ChildProcess | undefined;
    try {
      const pid = recorded.pid as number;
      const row = (await listProcessTable(10_000)).find((entry) => entry.pid === pid);
      host = spawn(process.execPath, ["--no-warnings", "--input-type=module", "-e", HOST], {
        env: { ...process.env, ROW: JSON.stringify(row), SHUTDOWN },
        stdio: ["ignore", "pipe", "inherit"],
      });
      const exited = once(host, "exit");
      const [line] = await once(host.stdout as NodeJS.ReadableStream, "data");
      const started = performance.now();
      expect(String(line)).toBe("reaping 1 recorded process\n");
      expect(await exited).toEqual([0, null]);
      // Each attempt's reads would otherwise hold the host for its whole deadline.
      expect(performance.now() - started).toBeLessThan(1_500);
    } finally {
      if (host !== undefined) await stopBystander(host);
      await stopBystander(recorded);
    }
  }, 30_000);

  test("a host whose reap waits for its next attempt exits at once", async () => {
    const host = spawn(process.execPath, ["--no-warnings", "--input-type=module", "-e", WAITER], {
      env: { ...process.env, SHUTDOWN },
      stdio: ["ignore", "pipe", "inherit"],
    });
    const exited = once(host, "exit");
    try {
      const [line] = await once(host.stdout, "data");
      const started = performance.now();
      expect(String(line)).toBe("reaping\n");
      expect(await exited).toEqual([0, null]);
      // A referenced timer would hold the host until the next attempt.
      expect(performance.now() - started).toBeLessThan(BACKGROUND_REAP_RETRY_MS * 0.8);
    } finally {
      await stopBystander(host);
    }
  }, 30_000);

  test("an unreferenced read still ends at its timeout", async () => {
    const options = { timeout: 50, maxBuffer: 1024, killSignal: "SIGKILL" as const, env: {} };
    await expect(runFileUnreferenced("/bin/sleep", ["5"], options)).rejects.toMatchObject({
      signal: "SIGKILL",
    });
  });
});

/** Records `ROW` as a hook of a made-up leader and reaps it in the background, signaling nothing. */
const HOST = `
const { DescendantRecord } = await import(process.env.SHUTDOWN + "/detached-sweep/record.ts");
const { reapInBackground } = await import(process.env.SHUTDOWN + "/detached-sweep/background.ts");
const { osProcessTreeOps } = await import(process.env.SHUTDOWN + "/process-tree-ops.ts");
const row = JSON.parse(process.env.ROW);
const leader = { ...row, pid: 999999, ppid: 1, pgid: 999999 };
const record = new DescendantRecord();
record.observe([leader, { ...row, ppid: leader.pid }], leader.pid);
const nowhere = () => undefined;
reapInBackground(record, {
  stopGroup: nowhere,
  killGroup: nowhere,
  continueGroup: nowhere,
  listProcesses: osProcessTreeOps.listProcessesUnreferenced,
});
process.stdout.write("reaping " + record.pids.length + " recorded process\\n");
`;

/**
 * Reaps a made-up hook in the background with scripted ops, which signal nothing and read
 * at once: the hook is stopped, held over two reads, and killed, and then the reap waits
 * for its next attempt.
 */
const WAITER = `
const { DescendantRecord } = await import(process.env.SHUTDOWN + "/detached-sweep/record.ts");
const { reapInBackground } = await import(process.env.SHUTDOWN + "/detached-sweep/background.ts");
const { UNREAD } = await import(process.env.SHUTDOWN + "/process-table.ts");
const leader = { ...UNREAD, pid: 999998, ppid: 1, pgid: 999998, startedAt: "made up" };
const hook = { ...UNREAD, pid: 999997, ppid: leader.pid, pgid: 999997, startedAt: "made up" };
const record = new DescendantRecord();
record.observe([leader, hook], leader.pid);
let stopped = false;
let killed = false;
reapInBackground(record, {
  stopGroup: () => void (stopped = true),
  killGroup: () => void (killed = true),
  continueGroup: () => undefined,
  listProcesses: () => Promise.resolve(killed ? [] : [{ ...hook, ppid: 1, stopped }]),
});
process.stdout.write("reaping\\n");
`;
