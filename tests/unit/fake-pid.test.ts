/**
 * The fakes' process ids (`tests/helpers/fake-pid.ts`, PRD §5.3, C-LIFE-10). The reap
 * never signals the test runner's own pid, so a fake PTY's pid is never one an OS can
 * assign: whatever pid the runner was handed, it is never the fake's.
 */

import { describe, expect, test } from "vitest";
import type { PtySpawnOptions } from "../../src/pty/types.ts";
import { FAKE_PID, LARGEST_OS_PID } from "../helpers/fake-pid.ts";
import { FakePty } from "../helpers/fake-pty.ts";

const options: PtySpawnOptions = {
  command: "/bin/sh",
  args: [],
  cwd: "/",
  env: {},
  size: { cols: 80, rows: 24 },
};

describe("C-LIFE-10 a fake PTY's pid", () => {
  test("is above every pid an OS assigns, given or not", () => {
    expect(FAKE_PID).toBeGreaterThan(LARGEST_OS_PID);
    expect(new FakePty(options).pid).toBeGreaterThan(LARGEST_OS_PID);
    expect(new FakePty(options, FAKE_PID + 1).pid).toBe(FAKE_PID + 1);
  });

  test("is refused when an OS could assign it, as it could be the runner's own", () => {
    expect(() => new FakePty(options, 1000)).toThrow("fake pid 1000 is one an OS can assign");
    expect(() => new FakePty(options, LARGEST_OS_PID)).toThrow(/an OS can assign/);
  });
});
