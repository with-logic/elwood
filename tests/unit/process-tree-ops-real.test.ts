/**
 * Production's real process-tree ops against a real process, on every platform (PRD §5.3
 * and §9.4, C-LIFE-10): the SIGSTOP stops a detached process's group, and the SIGCONT the
 * kill pass sends a group holding Codex's daemon sets it running again.
 */

import { expect, test } from "vitest";
import { osProcessTreeOps } from "../../src/runtime/shutdown/reap-tree.ts";
import { startBystander, stopBystander } from "../helpers/setsid-pair.ts";
import { readUntil } from "../helpers/table-reads.ts";

test("C-LIFE-10 the real ops stop a detached process's group, then resume it", async () => {
  const detached = startBystander();
  try {
    // Detached means `setsid()`: the process leads its own group.
    const pid = detached.pid;
    if (pid === undefined) throw new Error("the detached process did not spawn");
    osProcessTreeOps.stopGroup(pid);
    const stopped = await readUntil(pid, (row) => row?.stopped === true);
    expect(stopped.find((row) => row.pid === pid)).toMatchObject({ stopped: true });
    osProcessTreeOps.continueGroup(pid);
    const resumed = await readUntil(pid, (row) => row?.stopped === false);
    expect(resumed.find((row) => row.pid === pid)).toMatchObject({ stopped: false, zombie: false });
  } finally {
    await stopBystander(detached);
  }
});
