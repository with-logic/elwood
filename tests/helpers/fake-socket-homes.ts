/**
 * Private socket-home roots for the fake-PTY adapter suites (PRD §8.1). A session a test
 * starts binds its hook-bridge socket in a home under the OS temp dir, and a session the
 * test never ends keeps that home, socket file and all, after the run. `installFakes`
 * mints this test's homes under a fresh root instead, and the adapter helpers remove it
 * after each test. The root is under the short `/tmp`, not the long macOS `os.tmpdir()`:
 * a socket path there must clear the ~104-byte cap. Only the socket-home module is
 * redirected, never `TMPDIR` (see `setSocketHomeRootForTests`).
 */

import { mkdtempSync, rmSync } from "node:fs";
import {
  resetSocketHomeRootForTests,
  setSocketHomeRootForTests,
} from "../../src/state/socket-home.ts";

let root: string | undefined;

/** Mints the current test's socket homes under its own private root. */
export function isolateFakeSocketHomes(): void {
  root ??= mkdtempSync("/tmp/elwood_test_sock-");
  setSocketHomeRootForTests(root);
}

/** Restores the real socket-home root and removes the current test's private one. */
export function removeFakeSocketHomes(): void {
  resetSocketHomeRootForTests();
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
}
