/**
 * A session whose login shell the e2e home guard stops during startup names the guard even
 * when the stop line reaches the PTY after its exit, once the session's terminal has stopped
 * reading it (PRD §12, §9.4, C-E2E-24): the startup check keeps reading the PTY until it
 * settles.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { startClaude, startCodex } from "../../src/index.ts";
import {
  homeGuardHomesKey,
  homeGuardStopMarker,
  homeGuardStoppedReason,
} from "../../src/runtime/home-guard/index.ts";
import { setPtyFactoryForTests } from "../../src/runtime/seams.ts";
import * as claude from "../claude/helpers.ts";
import * as codex from "../codex/helpers.ts";
import { exitingBeforeLateOutput, rejection } from "../helpers/startup-exit.ts";

afterEach(() => {
  claude.resetFakes();
  codex.resetFakes();
  vi.unstubAllEnvs();
});

const stopLine = `${homeGuardStopMarker}: the login shell left its home unexported\r\n`;

describe.each([
  ["claude", claude, (cwd: string) => startClaude({ cwd })],
  ["codex", codex, (cwd: string) => startCodex({ cwd })],
] as const)("C-E2E-24 a %s start the guard stops", (adapter, fakes, start) => {
  test("names the guard when the stop line follows the exit and the terminal's last read", async () => {
    fakes.installFakes();
    vi.stubEnv(homeGuardHomesKey, "not a list"); // an unreadable list: the guard checks every launch
    setPtyFactoryForTests(exitingBeforeLateOutput(fakes.ptys, 97, stopLine));
    const failure = await rejection(start(fakes.tempDir()));
    expect(failure.code).toBe(`${adapter}_start_failed`);
    expect(failure.message).toBe(`${adapter} exited during startup: ${homeGuardStoppedReason}.`);
  });
});
