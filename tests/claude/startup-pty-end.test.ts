/**
 * Public-path coverage for ending a failed Claude start's PTY (PRD §9.1, C-LIFE-10). A
 * CLI that exits during a start or resume is never signaled again. The session's own
 * reaper SIGKILLs its group once, or retries once if the exit's reap failed. A CLI still
 * running gets one SIGTERM and one group reap, and its group is reaped even when the
 * signal throws. Signals and group kills reach injected fakes only.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { resumeClaude, startClaude } from "../../src/index.ts";
import { setPtyFactoryForTests } from "../../src/runtime/seams.ts";
import { setGroupKillerForTests } from "../../src/runtime/shutdown/reap-tree.ts";
import {
  exitingDuringStartup,
  rejection,
  runningWithStartupOutput,
  startupExit,
} from "../helpers/startup-exit.ts";
import { installFakes, ptys, reapedGroups, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

describe("C-LIFE-10 ending a failed Claude start's PTY", () => {
  test("a CLI that exits during startup is never signaled again; its group is reaped once", async () => {
    installFakes();
    setPtyFactoryForTests(exitingDuringStartup(ptys));
    const failure = await rejection(startClaude({ cwd: tempDir() }));
    expect(failure.code).toBe("claude_start_failed");
    expect(failure.details).toEqual(startupExit);
    expect(ptys[0]!.killSignals).toEqual([]);
    expect(reapedGroups).toEqual([ptys[0]!.pid]);
  });

  test("a failed exit-path reap is retried by cleanup's shared reaper, still unsignaled", async () => {
    installFakes();
    const attempts: number[] = [];
    setGroupKillerForTests({
      killGroup: (pgid) => {
        attempts.push(pgid);
        if (attempts.length === 1) throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
      },
    });
    setPtyFactoryForTests(exitingDuringStartup(ptys));
    const failure = await rejection(startClaude({ cwd: tempDir() }));
    expect(failure.code).toBe("claude_start_failed");
    expect(failure.details).toEqual(startupExit);
    expect(ptys[0]!.killSignals).toEqual([]);
    expect(attempts).toEqual([ptys[0]!.pid, ptys[0]!.pid]);
  });

  test("a CLI that exits during a resume is never signaled again either", async () => {
    installFakes();
    const cwd = tempDir();
    const original = await startClaude({ cwd });
    await ptys[0]!.dispatchHook(original.elwoodSessionId, {
      hook_event_name: "SessionStart",
      session_id: "claude-resume",
      cwd,
      source: "startup",
    });
    await original.stop();
    reapedGroups.length = 0;
    setPtyFactoryForTests(exitingDuringStartup(ptys));
    const failure = await rejection(
      resumeClaude({ cwd, elwoodSessionId: original.elwoodSessionId }),
    );
    expect(failure.code).toBe("claude_start_failed");
    expect(ptys[1]!.killSignals).toEqual([]);
    expect(reapedGroups).toEqual([ptys[1]!.pid]);
  });

  test("a CLI still running gets one SIGTERM and one group reap", async () => {
    installFakes();
    setPtyFactoryForTests(runningWithStartupOutput(ptys, "not authenticated"));
    const failure = await rejection(startClaude({ cwd: tempDir() }));
    expect(failure.code).toBe("claude_not_authenticated");
    expect(ptys[0]!.killSignals).toEqual(["SIGTERM"]);
    expect(reapedGroups).toEqual([ptys[0]!.pid]);
  });

  test("the group is still reaped when signaling the running CLI throws", async () => {
    installFakes();
    const running = runningWithStartupOutput(ptys, "not authenticated");
    setPtyFactoryForTests((options) => {
      const pty = running(options);
      vi.spyOn(pty, "kill").mockImplementation(() => {
        throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
      });
      return pty;
    });
    const failure = await rejection(startClaude({ cwd: tempDir() }));
    expect(failure.code).toBe("claude_not_authenticated");
    expect(reapedGroups).toEqual([ptys[0]!.pid]);
  });
});
