/** An unresolved update probe reaches the live warning as a bounded code (PRD §9.2, C-PERF-03). */
import { afterEach, expect, test, vi } from "vitest";
import { preflightCodex } from "../../src/codex/preflight.ts";
import { runProbe, setProbeTimeoutMsForTests } from "../../src/runtime/probe.ts";
import { setCommandRunnerForTests, setPlatformForTests } from "../../src/runtime/seams.ts";
import {
  resetAutoupdateForTests,
  resetPreflightCacheForTests,
  setUpdateCoordinatorForTests,
} from "../../src/runtime/update/once.ts";

const kill = process.kill.bind(process);
afterEach(() => vi.restoreAllMocks());

test("C-PERF-03 a real update probe whose cleanup stays unconfirmed warns with cleanupErrorCode", async () => {
  resetAutoupdateForTests();
  resetPreflightCacheForTests();
  setUpdateCoordinatorForTests((_adapter, update) => update());
  setPlatformForTests("darwin");
  setProbeTimeoutMsForTests(50);
  let group: number | undefined;
  // Only the updater is a real, hanging process; its group signals are swallowed.
  setCommandRunnerForTests(async (_command, args) => {
    if (!args.join(" ").includes("codex update"))
      return { status: 0, stdout: "codex-cli 0.154.0", stderr: "" };
    const result = await runProbe(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
    group = result.error?.cleanupProcessGroup;
    return result;
  });
  vi.spyOn(process, "kill").mockReturnValue(true);
  try {
    expect(await preflightCodex(false, true)).toMatchObject({
      code: "agent_update_failed",
      errorCode: "ETIMEDOUT",
      cleanupErrorCode: "ETIMEDOUT",
    });
    expect(group).toBeGreaterThan(0);
  } finally {
    if (group !== undefined) kill(-group, "SIGKILL");
  }
});
