/**
 * Where `terminatePty` runs the detached-descendant sweep, and how a sweep failure
 * is reported. Covers PRD §5.3/§9.4 (C-LIFE-10) and §10 (C-ERR-01): the sweep runs
 * before every SIGKILL Elwood sends a live leader and never after a graceful exit,
 * an exit that lands mid-sweep still counts and cancels the SIGKILL to a pid that may
 * be reused, and a sweep failure is typed and never drops another cause. All process
 * operations are fakes.
 */

import { describe, expect, test } from "vitest";
import { ElwoodError } from "../../src/core/errors.ts";
import type { PtyProcess } from "../../src/pty/types.ts";
import { terminatePty } from "../../src/runtime/shutdown/terminate.ts";
import { harness, sweepFailure, swept, timeouts } from "../helpers/termination-harness.ts";

describe("C-LIFE-10 terminatePty detached sweep", () => {
  test("kill sweeps detached descendants before it SIGKILLs the live leader", async () => {
    const { pty, reaper, calls } = harness({ exitsOn: ["SIGKILL"] });
    await terminatePty(pty, "SIGKILL", reaper, timeouts);
    expect(calls).toEqual([...swept, "signal SIGKILL", "unsubscribe", "reap"]);
  });

  test("a leader that exits on SIGTERM is not swept", async () => {
    const { pty, reaper, calls } = harness({ exitsOn: ["SIGTERM"] });
    await terminatePty(pty, "SIGTERM", reaper, timeouts);
    expect(calls).toEqual(["signal SIGTERM", "unsubscribe", "reap"]);
  });

  test("an ignored SIGTERM is swept before the escalating SIGKILL", async () => {
    const { pty, reaper, calls } = harness({ exitsOn: ["SIGKILL"] });
    await terminatePty(pty, "SIGTERM", reaper, timeouts);
    expect(calls).toEqual(["signal SIGTERM", ...swept, "signal SIGKILL", "unsubscribe", "reap"]);
  });

  test("an exit during the sweep is observed, and no SIGKILL goes to the retired pid", async () => {
    // node-pty never replays an exit; a subscription renewed after the sweep would
    // miss this one and report a leader that already died as failing to exit. Once it
    // is seen, the leader's pid may belong to another process, so nothing is sent to it.
    const { pty, reaper, calls } = harness({ exitDuringSweep: true });
    await expect(terminatePty(pty, "SIGTERM", reaper, timeouts)).resolves.toBeUndefined();
    expect(calls).toEqual([
      "signal SIGTERM",
      "sweep (exited: false)",
      "swept (exited: true)",
      "unsubscribe",
      "reap",
    ]);
  });

  test("a sweep failure alone rejects as typed termination_failed with its errno", async () => {
    const sweepError = sweepFailure("process table unreadable", [7001, 7002], "ETIMEDOUT");
    const { pty, reaper, calls } = harness({ exitsOn: ["SIGKILL"], sweepError });
    await expect(terminatePty(pty, "SIGKILL", reaper, timeouts)).rejects.toMatchObject({
      code: "termination_failed",
      message: "PTY exited but its detached descendants could not be confirmed reaped.",
      details: {
        cause: "Could not reap detached descendants: process table unreadable (ETIMEDOUT)",
        errno: "ETIMEDOUT",
        unconfirmedProcessGroupIds: [7001, 7002],
      },
    });
    // The leader is still killed and its group still reaped.
    expect(calls).toEqual([...swept, "signal SIGKILL", "unsubscribe", "reap"]);
  });

  test("a sweep failure rides along on an exit timeout instead of replacing it", async () => {
    const { pty, reaper } = harness({ sweepError: "sweep exploded" });
    const rejected: unknown = await terminatePty(pty, "SIGKILL", reaper, timeouts).then(
      () => undefined,
      (error: unknown) => error,
    );
    if (!(rejected instanceof ElwoodError)) throw new Error("expected an ElwoodError");
    expect(rejected).toMatchObject({
      code: "termination_failed",
      message: "PTY did not exit after SIGKILL.",
      details: { sweepError: "sweep exploded" },
    });
    expect(rejected.details).not.toHaveProperty("unconfirmedProcessGroupIds"); // none were named
  });

  test("a sweep failure rides along on a typed PTY signaling failure too", async () => {
    const { pty, reaper } = harness({
      sweepError: sweepFailure("could not kill a signaled descendant group", [7003]),
      killError: new Error("kill exploded"),
    });
    await expect(terminatePty(pty, "SIGKILL", reaper, timeouts)).rejects.toMatchObject({
      code: "termination_failed",
      message: "Could not terminate the PTY: kill exploded",
      details: {
        cause: "kill exploded",
        sweepError:
          "Could not reap detached descendants: could not kill a signaled descendant group",
        unconfirmedProcessGroupIds: [7003],
      },
    });
  });

  test("an exit subscription that throws still reaps", async () => {
    const { pty, reaper, calls } = harness({});
    const broken: PtyProcess = {
      ...pty,
      onExit: () => {
        throw new Error("subscribe failed");
      },
    };
    await expect(terminatePty(broken, "SIGKILL", reaper, timeouts)).rejects.toThrow(
      "subscribe failed",
    );
    expect(calls).toEqual(["reap"]);
  });
});
