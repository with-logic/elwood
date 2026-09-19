/**
 * The socket-leak suites must isolate their socket homes WITHOUT redirecting the
 * process-wide temp dir (PRD §8.1 test seam).
 *
 * `process.env` is per-PROCESS, and Vitest's default `forks` pool reuses one child
 * process across many test files (`isolate` resets the module registry, never the
 * environment). So when a leak test pointed `TMPDIR` at its private dir, every file
 * concurrently sharing that fork resolved `os.tmpdir()` there too — and the leak
 * test's `rm -rf` of that private dir then destroyed a sibling's scratch directory
 * mid-run. That was the rotating one-victim-per-parallel-run failure; serial runs
 * passed because no sibling shared the window.
 *
 * These tests pin the contract that makes the collision impossible: overriding the
 * socket-home root must NOT move `os.tmpdir()`, and must still redirect the homes.
 */

import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  resetSocketHomeRootForTests,
  sessionSocketHome,
  setSocketHomeRootForTests,
} from "../../src/state/socket-home.ts";
import { tempDir } from "../helpers/tmp.ts";

const identity = {
  stateDir: "/state/a",
  elwoodSessionId: "sess-1",
  adapter: "claude",
} as const;

afterEach(resetSocketHomeRootForTests);

test("§8.1 overriding the socket-home root leaves os.tmpdir() — and every sibling file — untouched", () => {
  const before = tmpdir();
  setSocketHomeRootForTests("/tmp/elwood-sockhome-probe");
  // The redirect is scoped to the socket-home module. If this ever regresses to
  // assigning process.env.TMPDIR, concurrent files in the same fork would start
  // creating their scratch dirs inside the private root and lose them to its rm -rf.
  expect(tmpdir()).toBe(before);
  expect(process.env["TMPDIR"] ?? before).not.toBe("/tmp/elwood-sockhome-probe");
});

test("§8.1 a scratch dir minted while the socket-home root is overridden stays outside it", () => {
  const priv = "/tmp/elwood-sockhome-probe";
  setSocketHomeRootForTests(priv);
  // This is exactly what a sibling test file does mid-window. It must NOT land under
  // the private root, or the leak test's cleanup would delete it while it is in use.
  expect(tempDir("elwood-sibling-scratch-").startsWith(priv)).toBe(false);
});

test("§8.1 the override still redirects socket homes, and resetting restores the real tmp", () => {
  const priv = "/tmp/elwood-sockhome-probe";
  setSocketHomeRootForTests(priv);
  expect(dirname(sessionSocketHome(identity))).toBe(priv);
  resetSocketHomeRootForTests();
  expect(dirname(sessionSocketHome(identity))).toBe(tmpdir());
});
