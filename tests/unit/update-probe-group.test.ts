/**
 * A real aborted update probe reports the group it could not confirm gone (PRD §9.2,
 * C-PERF-03). What the update lease then does with that group arrives with the retention
 * policy; this pins the producing side, which is what makes that policy reachable at all.
 */
import { afterEach, expect, test, vi } from "vitest";
import { probeFailureDetails } from "../../src/core/errors.ts";
import { runProbe, setProbeTimeoutMsForTests } from "../../src/runtime/probe.ts";

const kill = process.kill.bind(process);
afterEach(() => vi.restoreAllMocks());

test("C-PERF-03 an aborted probe whose group survives reports it in the typed error", async () => {
  setProbeTimeoutMsForTests(50);
  // Only the group signals are swallowed, so the updater is a real, genuinely hanging
  // process that outlives the abort rather than a stubbed failure.
  vi.spyOn(process, "kill").mockImplementation((pid, signal) =>
    signal === "SIGKILL" ? true : kill(pid, signal),
  );
  let group: number | undefined;
  try {
    const result = await runProbe(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
    group = result.error?.cleanupProcessGroupId;
    expect(result.error?.code).toBe("ETIMEDOUT");
    expect(group).toBeGreaterThan(1);
    // The id must survive into the error details a caller actually sees: that channel is
    // the only way the update lease can learn a group outlived its probe.
    expect(probeFailureDetails(result)).toMatchObject({
      errno: "ETIMEDOUT",
      cleanupErrorCode: "ETIMEDOUT",
      cleanupProcessGroupId: group,
    });
  } finally {
    if (group !== undefined) kill(-group, "SIGKILL");
  }
});
