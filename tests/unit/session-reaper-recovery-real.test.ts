/** Retained failed forced walks recover a real owned helper tree (C-LIFE-14). */
import { expect, test, vi } from "vitest";
import { osProcessTreeOps, SessionReaper } from "../../src/runtime/shutdown/reap-tree.ts";
import { terminatePty } from "../../src/runtime/shutdown/terminate.ts";
import { detachedDescendantPids, startDetachedTree } from "../helpers/detached-tree.ts";
import { delay, pollGone } from "../helpers/process-liveness.ts";

test("C-LIFE-14 real retained descendants recover after the original forced walk fails", async () => {
  const tree = startDetachedTree();
  const descendants = await detachedDescendantPids(tree);
  await delay(1100); // Identities must predate the first observation's whole start second.
  let reads = 0;
  const reaper = new SessionReaper(tree.pty.pid, {
    ...osProcessTreeOps,
    listProcesses: (ms, scope) =>
      ++reads === 1
        ? osProcessTreeOps.listProcesses(ms, scope)
        : Promise.reject(Object.assign(new Error("controlled read failure"), { code: "EIO" })),
  });
  await expect(terminatePty(tree.pty, "SIGKILL", reaper)).rejects.toMatchObject({
    code: "termination_failed",
  });
  for (const pid of descendants) expect(await pollGone({ pid, timeoutMs: 15_000 })).toBe(true);
  await vi.waitFor(() => expect(() => reaper.reapAndThrowOnDetachedSweepFailure()).not.toThrow(), {
    timeout: 10_000,
  });
}, 60_000);
