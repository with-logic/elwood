/**
 * How `terminatePty` watches a graceful stop's survivors, and how their failure is
 * reported (PRD §5.3/§9.4, C-LIFE-10, and §10, C-ERR-01): the SIGTERM follows the
 * watch's first read, and never goes to a leader that exited during it; the watch reaps
 * survivors only once the leader has exited, always ends, and a survivor failure is
 * typed, while an earlier sweep failure stays the one reported. All process operations
 * are fakes.
 */

import { describe, expect, test } from "vitest";
import { terminatePty } from "../../src/runtime/shutdown/terminate.ts";
import { harness, sweepFailure, timeouts, watched } from "../helpers/termination-harness.ts";

describe("C-LIFE-10 terminatePty survivor watch", () => {
  test("a SIGTERM follows the watch's first read, and survivors are reaped after the exit", async () => {
    const { pty, reaper, calls } = harness({ exitsOn: ["SIGTERM"] });
    await terminatePty(pty, "SIGTERM", reaper, timeouts);
    // Not swept: the leader exited on its own; its recorded survivors are reaped instead.
    expect(calls).toEqual([...watched, "unsubscribe", "survivors (leader gone: true)", "reap"]);
  });

  test("a leader that never exits is not reaped for survivors, and the watch ends", async () => {
    const { pty, reaper, calls } = harness({});
    await expect(terminatePty(pty, "SIGTERM", reaper, timeouts)).rejects.toMatchObject({
      message: "PTY did not exit after SIGKILL.",
    });
    expect(calls).toContain("survivors (leader gone: false)");
  });

  test("a survivor failure rejects as typed termination_failed with its groups", async () => {
    const survivorError = sweepFailure("could not kill a signaled descendant group", [7004]);
    const { pty, reaper, calls } = harness({ exitsOn: ["SIGTERM"], survivorError });
    await expect(terminatePty(pty, "SIGTERM", reaper, timeouts)).rejects.toMatchObject({
      code: "termination_failed",
      message: "PTY exited but its detached descendants could not be confirmed reaped.",
      details: { unconfirmedProcessGroupIds: [7004] },
    });
    expect(calls.at(-1)).toBe("reap"); // The leader's group is still reaped.
  });

  test("a sweep failure is the one reported when survivors fail as well", async () => {
    const sweepError = sweepFailure("process table unreadable", [7001]);
    const survivorError = sweepFailure("process table unreadable", [7005]);
    const { pty, reaper, calls } = harness({ exitsOn: ["SIGKILL"], sweepError, survivorError });
    await expect(terminatePty(pty, "SIGTERM", reaper, timeouts)).rejects.toMatchObject({
      details: { unconfirmedProcessGroupIds: [7001] },
    });
    expect(calls).toContain("survivors (leader gone: true)"); // The watch still ends.
  });

  test("a leader that exits during the first read gets no SIGTERM, and its survivors are reaped", async () => {
    // Once the exit is seen, the leader's pid may belong to another process.
    const { pty, reaper, calls } = harness({ exitDuringFirstRead: true });
    await terminatePty(pty, "SIGTERM", reaper, timeouts);
    expect(calls).toEqual([
      "watch",
      "first read",
      "unsubscribe",
      "survivors (leader gone: true)",
      "reap",
    ]);
  });
});
