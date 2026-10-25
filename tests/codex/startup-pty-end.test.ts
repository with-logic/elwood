/**
 * Public-path coverage for ending a failed Codex start's PTY (PRD §9.1, C-LIFE-10),
 * through the same session-owned termination as Claude: a CLI that exits during startup
 * is never signaled again, and the session's own reaper SIGKILLs its group once, or
 * retries once if the exit's reap failed. Signals and group kills reach injected fakes
 * only.
 */

import { afterEach, expect, test } from "vitest";
import { startCodex } from "../../src/index.ts";
import { setPtyFactoryForTests } from "../../src/runtime/seams.ts";
import { setProcessTreeOpsForTests } from "../../src/runtime/shutdown/reap-tree.ts";
import { exitingDuringStartup, rejection, startupExit } from "../helpers/startup-exit.ts";
import { installFakes, ptys, reapedGroups, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

test("C-LIFE-10 a Codex CLI that exits during startup is never signaled again; its group is reaped once", async () => {
  installFakes();
  setPtyFactoryForTests(exitingDuringStartup(ptys));
  const failure = await rejection(startCodex({ cwd: tempDir() }));
  expect(failure.code).toBe("codex_start_failed");
  expect(failure.details).toEqual(startupExit);
  expect(ptys[0]!.killSignals).toEqual([]);
  expect(reapedGroups).toEqual([ptys[0]!.pid]);
});

test("C-LIFE-10 a failed Codex exit-path reap is retried by cleanup's shared reaper, still unsignaled", async () => {
  installFakes();
  const attempts: number[] = [];
  setProcessTreeOpsForTests({
    killGroup: (pgid) => {
      attempts.push(pgid);
      if (attempts.length === 1) throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
    },
  });
  setPtyFactoryForTests(exitingDuringStartup(ptys));
  const failure = await rejection(startCodex({ cwd: tempDir() }));
  expect(failure.code).toBe("codex_start_failed");
  expect(failure.details).toEqual(startupExit);
  expect(ptys[0]!.killSignals).toEqual([]);
  expect(attempts).toEqual([ptys[0]!.pid, ptys[0]!.pid]);
});
