/**
 * Claude adapter test harness: installs the PTY/command/reaper seams (PRD §13) with the
 * shared `FakePty`, tracks the ptys and reaped process groups a test can inspect, and
 * hands out scratch dirs that are removed after each test, as are the socket homes of
 * the sessions it starts (`fake-socket-homes.ts`).
 */

import { afterEach } from "vitest";
import { resetClaudeSessionSeamsForTests } from "../../src/claude/session/index.ts";
import {
  resetRuntimeSeamsForTests,
  setCommandRunnerForTests,
  setPlatformForTests,
  setPtyFactoryForTests,
} from "../../src/runtime/seams.ts";
import {
  resetProcessTreeOpsForTests,
  setProcessTreeOpsForTests,
} from "../../src/runtime/shutdown/reap-tree.ts";
import {
  resetStartupWaitMsForTests,
  setStartupWaitMsForTests,
} from "../../src/runtime/startup/index.ts";
import { resetPreflightCacheForTests } from "../../src/runtime/update/once.ts";
import { FAKE_PID } from "../helpers/fake-pid.ts";
import { createScratchRegistry, FakePty } from "../helpers/fake-pty.ts";
import { isolateFakeSocketHomes, removeFakeSocketHomes } from "../helpers/fake-socket-homes.ts";

export { type BridgeReply, dispatchRaw, FakePty, readBridgeScript } from "../helpers/fake-pty.ts";

export const ptys: FakePty[] = [];
/** Process-group ids that session teardown asked the reaper to SIGKILL. */
export const reapedGroups: number[] = [];

const versionOk = () => ({ status: 0, stdout: "2.1.144\n", stderr: "" });
const scratch = createScratchRegistry("elwood_test_claude-");

afterEach(async () => {
  await removeFakeSocketHomes();
  scratch.removeAll();
});

export function installFakes(): void {
  setPlatformForTests("darwin");
  isolateFakeSocketHomes();
  setCommandRunnerForTests(versionOk);
  setStartupWaitMsForTests(25);
  // Record group reaps instead of issuing a real SIGKILL to a live pgid.
  setProcessTreeOpsForTests({ killGroup: (pgid) => reapedGroups.push(pgid) });
  setPtyFactoryForTests((options) => {
    const pty = new FakePty(options, FAKE_PID + ptys.length);
    ptys.push(pty);
    return pty;
  });
}

export function resetFakes(): void {
  resetRuntimeSeamsForTests();
  resetStartupWaitMsForTests();
  resetPreflightCacheForTests();
  resetClaudeSessionSeamsForTests();
  resetProcessTreeOpsForTests();
  ptys.length = 0;
  reapedGroups.length = 0;
}

/** A fresh scratch directory (removed after the current test). */
export function tempDir(): string {
  return scratch.make();
}
