/** Failed-startup native exit cannot race its group confirmation (C-LIFE-10). */
import { afterEach, expect, test, vi } from "vitest";
import { startClaude } from "../../src/index.ts";
import { PtyExitLatch } from "../../src/pty/exit-latch.ts";
import { setPtyFactoryForTests } from "../../src/runtime/seams.ts";
import { SessionReapPolicy } from "../../src/runtime/session/reap.ts";
import type { ProcessEntry } from "../../src/runtime/shutdown/process-table.ts";
import { setProcessTreeOpsForTests } from "../../src/runtime/shutdown/reap-tree.ts";
import { errno, heldLeaderRow } from "../helpers/scripted-process-tree.ts";
import { runningWithStartupOutput } from "../helpers/startup-exit.ts";
import { installFakes, ptys, reapedGroups, resetFakes, tempDir } from "./helpers.ts";

afterEach(() => {
  vi.restoreAllMocks();
  resetFakes();
});

test.each([
  "gone",
  "live",
  "failed",
] as const)("C-LIFE-10 a late failed-startup exit defers reap until %s EPERM confirmation settles", async (kind) => {
  installFakes();
  const readStarted = Promise.withResolvers<void>();
  const confirmation = Promise.withResolvers<readonly ProcessEntry[]>();
  const exitReap = vi.spyOn(SessionReapPolicy.prototype, "bestEffort");
  // Skip only the graceful wait; the real startup, sweep and exit callback still run.
  vi.spyOn(PtyExitLatch.prototype, "within").mockResolvedValueOnce(false);
  let termSent = false;
  let confirming = false;
  const ownedLeader = () => heldLeaderRow(ptys[0]!.pid);
  setProcessTreeOpsForTests({
    stopGroup: () => {
      if (!termSent) return;
      confirming = true;
      throw errno("EPERM");
    },
    listProcesses: () => {
      if (!confirming) return Promise.resolve([ownedLeader()]);
      readStarted.resolve();
      return confirmation.promise;
    },
    killGroup: (pgid) => reapedGroups.push(pgid),
  });
  const running = runningWithStartupOutput(ptys, "not authenticated");
  setPtyFactoryForTests((options) => {
    const pty = running(options);
    vi.spyOn(pty, "kill").mockImplementation(() => {
      termSent = true;
    });
    return pty;
  });
  const starting = startClaude({ cwd: tempDir() }).catch((error: unknown) => error);
  try {
    await readStarted.promise;
    ptys[0]!.emitExit({ exitCode: 0 });
    await vi.waitFor(() => expect(exitReap).toHaveBeenCalledOnce());
    // This exit callback reached the same reaper while its fresh read was held.
    expect(reapedGroups).toEqual([]);
  } finally {
    if (kind === "failed") confirmation.reject(errno("EIO"));
    else confirmation.resolve(kind === "gone" ? [] : [ownedLeader()]);
    expect(await starting).toMatchObject({
      code: "claude_not_authenticated",
      ...(kind === "gone"
        ? {}
        : { details: { cleanupErrorCode: kind === "failed" ? "UnknownError" : "EPERM" } }),
    });
  }
  expect(reapedGroups).toEqual([]);
  expect(ptys[0]!.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
});
