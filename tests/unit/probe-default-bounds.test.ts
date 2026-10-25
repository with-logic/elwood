/**
 * The production probe bounds with no test override: the login shell has 60 s to announce
 * its command, and the command has 15 s after that (PRD §9.2, C-PERF-03, C-PERF-05). Fake
 * timers stand in for the minute; the child, its pipes and its abort cleanup stay real.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  probeCommandTimeoutMs,
  probeLaunchTimeoutMs,
  resetProbeTimeoutsForTests,
  runProbe,
} from "../../src/runtime/probe.ts";
import { probeStartScript } from "../../src/runtime/probe-start.ts";
import type { CommandResult } from "../../src/runtime/seams.ts";
import { tempDir } from "../helpers/tmp.ts";

beforeEach(() => {
  resetProbeTimeoutsForTests();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});
afterEach(() => vi.useRealTimers());

/** Lets real I/O and the real child run while the fake clock stands still. */
async function realWait(ms: number): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) await new Promise((resolve) => setImmediate(resolve));
}

function tracked(probe: Promise<CommandResult>) {
  const state: { result?: CommandResult } = {};
  void probe.then((result) => {
    state.result = result;
  });
  return state;
}

async function settled(state: { result?: CommandResult }): Promise<CommandResult | undefined> {
  for (let i = 0; i < 200 && state.result === undefined; i += 1) await realWait(25);
  return state.result;
}

test("C-PERF-05 by default the login shell has 60 seconds to start the probe command", async () => {
  const probe = tracked(runProbe("/bin/sh", ["-c", "sleep 30"]));
  await realWait(50);
  await vi.advanceTimersByTimeAsync(probeLaunchTimeoutMs - 1);
  expect(probe.result).toBeUndefined();
  await vi.advanceTimersByTimeAsync(1);
  expect((await settled(probe))?.error).toMatchObject({
    code: "ETIMEDOUT",
    message: "login shell did not start the probe command within 60000 ms",
    phase: "login_shell",
  });
});

test("C-PERF-03 by default the probe command has 15 seconds from the start line", async () => {
  const started = join(tempDir("elwood-probe-"), "started");
  const probe = tracked(
    runProbe("/bin/sh", ["-c", `${probeStartScript}touch '${started}'; sleep 30`]),
  );
  for (let i = 0; i < 400 && !existsSync(started); i += 1) await realWait(25);
  await realWait(100); // the start line precedes the file, but give its pipe a beat
  await vi.advanceTimersByTimeAsync(probeCommandTimeoutMs - 1);
  expect(probe.result).toBeUndefined();
  await vi.advanceTimersByTimeAsync(1);
  const result = await settled(probe);
  expect(result?.error).toMatchObject({
    code: "ETIMEDOUT",
    message: "probe timed out after 15000 ms",
  });
  expect(result?.error).not.toHaveProperty("phase");
});
