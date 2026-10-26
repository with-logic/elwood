/**
 * A Claude session whose detached-descendant sweep fails (PRD §5.3, §9.4, §10 and
 * §12A.2; C-LIFE-10, C-CLI-09). The failure is sticky: every later shutdown rejects too.
 * Runtime cleanup still runs, and `teardown_failed` keeps the typed failure, so the
 * CLI's cleanup diagnostic can name it.
 */

import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { cleanupFailureMessage } from "../../src/cli/output/cleanup-error.ts";
import { startClaude } from "../../src/index.ts";
import { setProcessTreeOpsForTests } from "../../src/runtime/shutdown/reap-tree.ts";
import { bridgeAccepts } from "../helpers/fake-pty.ts";
import { onlyLaunchArtifact } from "../helpers/launch-artifacts.ts";
import {
  installFakes,
  ptys,
  readBridgeScript,
  reapedGroups,
  resetFakes,
  tempDir,
} from "./helpers.ts";

afterEach(resetFakes);

test("C-LIFE-10 an unresolved detached sweep keeps every later shutdown failing", async () => {
  // kill() could not read the process table, so a detached hook may still run under
  // PID 1. The leader is dead and its group reaped, so nothing can confirm it any
  // more: a later stop() or teardown() must keep rejecting, never report success.
  installFakes();
  setProcessTreeOpsForTests({
    killGroup: (pgid) => reapedGroups.push(pgid),
    listProcesses: () => Promise.reject(Object.assign(new Error("ps"), { code: "EAGAIN" })),
  });
  const cwd = tempDir();
  const session = await startClaude({ cwd });
  const sessionDir = join(cwd, ".elwood", "sessions", session.elwoodSessionId);
  const { socketPath } = readBridgeScript(onlyLaunchArtifact(sessionDir, "hook-bridge"));
  expect(await bridgeAccepts(socketPath)).toBe(true);
  const unreadable = "Could not reap detached descendants: process table unreadable (EAGAIN)";
  await expect(session.kill()).rejects.toMatchObject({
    code: "termination_failed",
    details: { cause: unreadable, errno: "EAGAIN" },
  });
  expect(reapedGroups).toEqual([ptys.at(-1)!.pid]); // the leader group itself was reaped
  expect(await bridgeAccepts(socketPath)).toBe(false); // runtime cleanup ran regardless
  await expect(session.stop()).rejects.toMatchObject({
    code: "termination_failed",
    details: { cause: unreadable },
  });
  const teardown = await session.teardown().then(
    () => undefined,
    (error: unknown) => error,
  );
  const leader = ptys.at(-1)!.pid;
  const unconfirmed = "Could not confirm the PTY process tree was reaped.";
  expect(teardown).toMatchObject({
    code: "teardown_failed",
    details: {
      causes: [unconfirmed],
      failures: [
        {
          message: unconfirmed,
          code: "termination_failed",
          details: { cause: unreadable, errno: "EAGAIN", processGroupId: leader },
        },
      ],
    },
  });
  expect(cleanupFailureMessage(teardown)).toBe(
    `Cleanup failed (termination_failed EAGAIN process groups ${leader}).`,
  );
});
