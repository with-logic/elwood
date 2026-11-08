/** Retained failed forced walks recover a real owned helper tree (C-LIFE-14). */
import { expect, test, vi } from "vitest";
import { osProcessTreeOps, SessionReaper } from "../../src/runtime/shutdown/reap-tree.ts";
import { terminatePty } from "../../src/runtime/shutdown/terminate.ts";
import { detachedDescendantPids, startDetachedTree } from "../helpers/detached-tree.ts";
import { delay, pollGone } from "../helpers/process-liveness.ts";
import { DISTINCT_PROCESS_START_DELAY_MS } from "../helpers/process-start-time.ts";

test("C-LIFE-14 real retained descendants recover after the original forced walk fails", async () => {
  const tree = startDetachedTree();
  const descendants = await detachedDescendantPids(tree);
  await delay(DISTINCT_PROCESS_START_DELAY_MS);
  let failureInjected = false;
  const reaper = new SessionReaper(tree.pty.pid, {
    ...osProcessTreeOps,
    killGroup: (group) => {
      if (!failureInjected && group !== tree.pty.pid) {
        failureInjected = true;
        throw Object.assign(new Error("controlled detached-group KILL failure"), { code: "EIO" });
      }
      osProcessTreeOps.killGroup(group);
    },
  });
  await expect(terminatePty(tree.pty, "SIGKILL", reaper)).rejects.toMatchObject({
    code: "termination_failed",
  });
  expect(failureInjected).toBe(true);
  for (const pid of descendants) expect(await pollGone({ pid, timeoutMs: 15_000 })).toBe(true);
  await vi.waitFor(
    () =>
      expect(
        Promise.resolve().then(() => reaper.reapOrConfirmAndThrowIfUnresolved()),
      ).resolves.toBeUndefined(),
    { timeout: 10_000 },
  );
}, 60_000);
