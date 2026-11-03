/**
 * The results a probe settles with when its command did not simply exit, in full (PRD §9.2,
 * C-PERF-03, C-PERF-05, C-E2E-24): every field each one carries, which preflight diagnostics
 * and update warnings read.
 */

import { expect, test } from "vitest";
import { homeGuardExitCode, homeGuardStoppedReason } from "../../src/runtime/home-guard/index.ts";
import { maxProbeStreamOutputBytes } from "../../src/runtime/probe/capped-buffer.ts";
import {
  commandTimedOut,
  guardStopped,
  launchTimedOut,
  mapError,
  overflow,
  shellExited,
} from "../../src/runtime/probe/results.ts";

test("a spawn error keeps its code and message, and only those", () => {
  const error = Object.assign(new Error("spawn /no/such/shell ENOENT"), {
    code: "ENOENT",
    errno: -2,
    path: "/no/such/shell",
  });
  expect(mapError(error)).toStrictEqual({ code: "ENOENT", message: "spawn /no/such/shell ENOENT" });
});

const output = { stdout: "out", stderr: "err" };

test.each([
  [
    "a command past its bound",
    commandTimedOut(150, "out", "err"),
    { code: "ETIMEDOUT", message: "probe timed out after 150 ms" },
  ],
  [
    "a login shell past its bound",
    launchTimedOut(150, "out", "err"),
    {
      code: "ETIMEDOUT",
      message: "login shell did not start the probe command within 150 ms",
      phase: "login_shell",
    },
  ],
  [
    "a login shell that exited before the command",
    shellExited(2, "out", "err"),
    {
      message: "login shell exited with status 2 before starting the probe command",
      phase: "login_shell",
      shellStatus: 2,
    },
  ],
  [
    "a probe the e2e home guard stopped",
    guardStopped("out", "err"),
    { message: homeGuardStoppedReason, phase: "login_shell", shellStatus: homeGuardExitCode },
  ],
  [
    "a stream past the output cap",
    overflow("out", "err"),
    { code: "E2BIG", message: `a probe output stream exceeded ${maxProbeStreamOutputBytes} bytes` },
  ],
])("%s settles with no status, its output, and its error", (_, result, error) => {
  expect(result).toStrictEqual({ status: null, ...output, error });
});
