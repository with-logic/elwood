/**
 * The survivor reap on real processes (PRD §5.3 and §9.4, C-LIFE-10): with real SIGSTOP,
 * SIGKILL, and `/bin/ps`, the watch's record reaps the setsid descendants a leader leaves
 * on SIGTERM, refusing newly ambiguous identities and sparing unrelated processes,
 * Codex's app-server daemon, and its updater loop.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { watchSurvivors } from "../../src/runtime/shutdown/detached-sweep/survivors.ts";
import { listProcessTable } from "../../src/runtime/shutdown/process-table.ts";
import { osProcessTreeOps } from "../../src/runtime/shutdown/reap-tree.ts";
import { markingLateSeen } from "../helpers/detached-tree/observed-late.ts";
import {
  type DetachedTree,
  detachedDescendantPids,
  startDetachedTree,
  waitForTreeProcessPid,
} from "../helpers/detached-tree.ts";
import { delay, pollGone, processRows } from "../helpers/process-liveness.ts";
import { DISTINCT_PROCESS_START_DELAY_MS } from "../helpers/process-start-time.ts";
import { startBystander, stopBystander } from "../helpers/setsid-pair.ts";

const realOps = osProcessTreeOps;
const RUNNING = { zombie: false, stopped: false };

/** Sends `tree`'s leader SIGTERM under a survivor watch and reaps once it exits. */
async function stopWatched(tree: DetachedTree, afterExit: () => Promise<void> = async () => {}) {
  let exited = false;
  const exit = new Promise<void>((resolve) => {
    tree.pty.onExit(() => {
      exited = true;
      resolve();
    });
  });
  const outcomes: unknown[] = [];
  const watch = watchSurvivors(
    tree.pty.pid,
    { ...realOps, listProcesses: markingLateSeen(tree, (row) => !row.zombie) },
    () => exited,
    (outcome) => {
      outcomes.push(outcome);
    },
  );
  await watch.firstRead;
  tree.pty.kill("SIGTERM");
  await exit;
  await afterExit();
  await watch.finish();
  return outcomes;
}

afterEach(() => vi.restoreAllMocks());

describe("C-LIFE-10 survivor reap on real processes", () => {
  test("reaps older survivors but refuses a newly observed ambiguous late child", async () => {
    const tree = startDetachedTree("late-until-seen");
    const bystander = startBystander();
    try {
      const [child, grandchild] = await detachedDescendantPids(tree);
      await delay(DISTINCT_PROCESS_START_DELAY_MS);
      // Keep observation epochs fixed while native deadlines and process cleanup remain real.
      vi.spyOn(Date, "now").mockReturnValue(Date.now());
      let late = 0;
      const outcomes = await stopWatched(tree, async () => {
        late = await waitForTreeProcessPid(tree, "late");
      });
      expect(outcomes).toMatchObject([{ message: expect.stringContaining("ambiguous identity") }]);
      expect((await listProcessTable(10_000)).find((row) => row.pid === late)).toMatchObject(
        RUNNING,
      );
      for (const pid of [child, grandchild]) {
        expect(await pollGone({ pid, timeoutMs: 5_000 })).toBe(true);
      }
      const table = await listProcessTable(10_000);
      expect(table.find((row) => row.pid === bystander.pid)).toMatchObject(RUNNING);
    } finally {
      await stopBystander(bystander);
    }
  }, 60_000);

  // Linux `ps` shows the executable's name as the command name, not argv[0].
  test.skipIf(process.platform !== "darwin")(
    "never reaps Codex's app-server daemon or its updater loop, which the leader leaves too",
    async () => {
      const tree = startDetachedTree("with-daemon");
      const [child, grandchild] = await detachedDescendantPids(tree);
      const spared = await Promise.all([
        waitForTreeProcessPid(tree, "daemon"),
        waitForTreeProcessPid(tree, "updater"),
        waitForTreeProcessPid(tree, "mcp"),
      ]);
      await delay(DISTINCT_PROCESS_START_DELAY_MS);
      expect(await stopWatched(tree)).toEqual([undefined]);
      for (const pid of [child, grandchild]) {
        expect(await pollGone({ pid, timeoutMs: 5_000 })).toBe(true);
      }
      const rows = processRows(10_000);
      for (const pid of spared) {
        // Running, and still this tree's process, not a reuse of its pid.
        const row = rows.find((entry) => entry.pid === pid);
        expect(row?.command).toContain(tree.dir);
        expect(row?.stat).toMatch(/^[^TZ]/);
      }
    },
    60_000,
  );
});
