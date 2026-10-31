/**
 * The background reap against real processes (PRD §5.3, C-LIFE-14). A `kill` whose walk
 * reads its tree once and then cannot read the table again rejects with a setsid hook and
 * its setsid child still running, under PID 1 once the leader is killed. Reaped in the
 * background by pid and start time, with real reads and signals, both end, and a later
 * call resolves. A host left with nothing but that reap to do exits at once, whether the
 * reap is reading or waiting for its next attempt.
 */

import { spawn } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { BACKGROUND_REAP_RETRY_MS } from "../../src/runtime/shutdown/detached-sweep/background.ts";
import { osProcessTreeOps, SessionReaper } from "../../src/runtime/shutdown/reap-tree.ts";
import { terminatePty } from "../../src/runtime/shutdown/terminate.ts";
import { runFileUnreferenced } from "../../src/runtime/shutdown/unreferenced-read.ts";
import { PENDING_READ_HOST, WAITING_RETRY_HOST } from "../helpers/background-hosts.ts";
import { detachedDescendantPids, startDetachedTree } from "../helpers/detached-tree.ts";
import { killIfCommandHas, pollGone } from "../helpers/process-liveness.ts";
import { stopBystander } from "../helpers/setsid-pair.ts";
import { tempDir } from "../helpers/tmp.ts";

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

  test("a host exits while its controlled process-table read is still pending", async () => {
    const marker = tempDir("elwood-pending-read-");
    const host = spawn(
      process.execPath,
      ["--no-warnings", "--input-type=module", "-e", PENDING_READ_HOST],
      {
        env: { ...process.env, SHUTDOWN, MARKER: marker },
        stdio: ["ignore", "pipe", "inherit"],
      },
    );
    const exited = once(host, "exit");
    let readerPid: number | undefined;
    try {
      const [line] = await once(host.stdout, "data");
      readerPid = Number(String(line).trim().split(" ")[1]);
      expect(Number.isInteger(readerPid)).toBe(true);
      const started = performance.now();
      expect(
        await Promise.race([
          exited,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("referenced read held the host")), 1_500).unref(),
          ),
        ]),
      ).toEqual([0, null]);
      expect(performance.now() - started).toBeLessThan(1_500);
      process.kill(readerPid, 0); // The read is still pending, not a quickly completed ps.
    } finally {
      await stopBystander(host);
      if (readerPid !== undefined) killIfCommandHas(readerPid, marker);
    }
  }, 10_000);

  test("a host whose reap waits for its next attempt exits at once", async () => {
    const host = spawn(
      process.execPath,
      ["--no-warnings", "--input-type=module", "-e", WAITING_RETRY_HOST],
      {
        env: { ...process.env, SHUTDOWN },
        stdio: ["ignore", "pipe", "inherit"],
      },
    );
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
