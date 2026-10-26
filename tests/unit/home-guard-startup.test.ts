/**
 * How a session's startup check reads the e2e home guard's stop (PRD §12, C-E2E-24). For a
 * launch the guard checks, a login shell that exits 97 during startup fails naming the guard
 * only when its output carried the stop marker: after more startup output than the startup
 * buffer keeps, split across chunks, or reaching the PTY after the exit (§9.4), within a
 * bounded wait. Any other status, 97 without the marker, or a launch the guard does not check
 * fails as before, and a launch it does not check fails at once.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  homeGuardChecksLaunch,
  homeGuardHomesKey,
  homeGuardStopMarker,
  homeGuardStoppedReason,
} from "../../src/runtime/home-guard/index.ts";
import { assertStartupThenRelease, createStartupBuffer } from "../../src/runtime/startup/buffer.ts";
import {
  resetStartupWaitMsForTests,
  setStartupWaitMsForTests,
} from "../../src/runtime/startup/index.ts";

beforeEach(() => {
  setStartupWaitMsForTests(0);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  resetStartupWaitMsForTests();
  vi.unstubAllEnvs();
});

const adapters = [
  ["codex", "CODEX_HOME", "CLAUDE_CONFIG_DIR"],
  ["claude", "CLAUDE_CONFIG_DIR", "CODEX_HOME"],
] as const;
type Adapter = (typeof adapters)[number][0];

const stopLine = `${homeGuardStopMarker}: the login shell left its home unexported\r\n`;
const namesGuard = (adapter: Adapter) => ({
  code: `${adapter}_start_failed`,
  message: `${adapter} exited during startup: ${homeGuardStoppedReason}.`,
  details: { exitCode: 97 },
});
const asBefore = (adapter: Adapter, exitCode: number) => ({
  code: `${adapter}_start_failed`,
  message: `${adapter} exited during startup.`,
  details: { exitCode },
});

/** `adapter`'s startup check, for a shell that exited `exitCode` after writing `chunks`. */
function startup(
  adapter: Adapter,
  exitCode: number,
  guarded: boolean,
  ...chunks: readonly string[]
) {
  const buffer = createStartupBuffer({ watchStopMarker: guarded });
  for (const chunk of chunks) buffer.push(chunk);
  const check = assertStartupThenRelease(adapter, buffer, () => ({ exitCode }));
  // Settled at once, or after `ms` of fake time: whichever the check takes.
  const settled = async (ms = 0) => {
    const result = check.then(
      () => "resolved",
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(ms);
    return result;
  };
  return { buffer, settled };
}

describe.each(
  adapters,
)("C-E2E-24 a %s session whose login shell exits during startup", (adapter) => {
  test("with the guard's status and stop line, fails naming the guard at once", async () => {
    const { settled } = startup(adapter, 97, true, "profile output\r\n", stopLine);
    expect(await settled()).toMatchObject(namesGuard(adapter));
  });

  test("whose stop line follows more output than the startup buffer keeps, split, names the guard", async () => {
    const profile = "profile output\r\n".repeat(5_000); // 80 KB, past the buffer's 64 KiB
    const split = [stopLine.slice(0, 20), stopLine.slice(20)];
    const { settled } = startup(adapter, 97, true, profile, ...split);
    expect(await settled()).toMatchObject(namesGuard(adapter));
  });

  test("whose stop line reaches the PTY after its exit, within the wait, names the guard", async () => {
    const { buffer, settled } = startup(adapter, 97, true, "profile output\r\n");
    setTimeout(() => buffer.push(stopLine), 990);
    expect(await settled(1_000)).toMatchObject(namesGuard(adapter));
  });

  test("whose stop line comes after the wait, fails as before", async () => {
    const { buffer, settled } = startup(adapter, 97, true, "profile output\r\n");
    setTimeout(() => buffer.push(stopLine), 1_010);
    expect(await settled(1_020)).toMatchObject(asBefore(adapter, 97));
  });

  test("with another status after the stop line, fails as before at once", async () => {
    const { settled } = startup(adapter, 1, true, stopLine);
    expect(await settled()).toMatchObject(asBefore(adapter, 1));
  });

  test("of a launch the guard does not check, fails as before at once", async () => {
    const { settled } = startup(adapter, 97, false, "profile output\r\n", stopLine);
    expect(await settled()).toMatchObject(asBefore(adapter, 97));
  });
});

describe.each(adapters)("C-E2E-24 which %s launches the guard checks", (_adapter, home, other) => {
  test.each([
    ["is unset", undefined, false],
    ["is empty", "", false],
    ["names no home", "[]", false],
    ["names a home no variable is set to", '["/elsewhere"]', false],
    [`names the home ${home} is set to`, '["/private/home"]', true],
    ["cannot be read", "not a list", true],
  ])("a launch whose list %s: %s", (_case, list, checked) => {
    vi.stubEnv(home, "/private/home");
    vi.stubEnv(other, undefined);
    vi.stubEnv(homeGuardHomesKey, list);
    expect(homeGuardChecksLaunch()).toBe(checked);
    expect(createStartupBuffer().sawStopMarker !== undefined).toBe(checked);
  });
});
