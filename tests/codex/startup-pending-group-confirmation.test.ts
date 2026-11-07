/** Codex's failed-startup exit waits for its held group confirmation (PRD §9.1, C-LIFE-10). */
import { afterEach, expect, test, vi } from "vitest";
import { startCodex } from "../../src/index.ts";
import { PtyExitLatch } from "../../src/pty/exit-latch.ts";
import { currentPtyFactory, setPtyFactoryForTests } from "../../src/runtime/seams.ts";
import { SessionReapPolicy } from "../../src/runtime/session/reap.ts";
import type { ProcessEntry } from "../../src/runtime/shutdown/process-table.ts";
import { setProcessTreeOpsForTests } from "../../src/runtime/shutdown/reap-tree.ts";
import { errno, heldLeaderRow } from "../helpers/scripted-process-tree.ts";
import { installFakes, ptys, reapedGroups, resetFakes, tempDir } from "./helpers.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetFakes();
});

test.each([
  "gone",
  "live",
  "failed",
] as const)("C-LIFE-10 Codex startup exit defers reap until %s EPERM confirmation settles", async (kind) => {
  installFakes();
  vi.useFakeTimers();
  const readStarted = Promise.withResolvers<void>();
  const confirmation = Promise.withResolvers<readonly ProcessEntry[]>();
  const exitReap = vi.spyOn(SessionReapPolicy.prototype, "bestEffort");
  // Skip only the graceful wait; Codex's actual startup and exit wiring still run.
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
  const spawn = currentPtyFactory();
  setPtyFactoryForTests((options) => {
    const pty = spawn(options);
    vi.spyOn(pty, "kill").mockImplementation(() => {
      termSent = true;
    });
    return pty;
  });
  const starting = startCodex({ cwd: tempDir() }).catch((error: unknown) => error);
  try {
    await vi.waitFor(() => expect(ptys[0]?.dataHandlers.length).toBe(2), { interval: 1 });
    ptys[0]!.emitData("not authenticated");
    await vi.advanceTimersByTimeAsync(50);
    await readStarted.promise;
    ptys[0]!.emitExit({ exitCode: 0 });
    await vi.waitFor(() => expect(exitReap).toHaveBeenCalledOnce());
    expect(reapedGroups).toEqual([]);
  } finally {
    if (kind === "failed") confirmation.reject(errno("EIO"));
    else confirmation.resolve(kind === "gone" ? [] : [ownedLeader()]);
    expect(await starting).toMatchObject({
      code: "codex_not_authenticated",
      ...(kind === "gone"
        ? {}
        : { details: { cleanupErrorCode: kind === "failed" ? "UnknownError" : "EPERM" } }),
    });
  }
  expect(reapedGroups).toEqual([]);
  expect(ptys[0]!.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
});
