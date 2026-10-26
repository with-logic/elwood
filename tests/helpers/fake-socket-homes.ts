/**
 * Private socket-home roots for the fake-PTY adapter suites (PRD §8.1). A session a test
 * starts binds its hook-bridge socket in a home under the OS temp dir, and a session the
 * test never ends keeps that home, socket file and all, after the run. `installFakes`
 * mints this test's homes under a fresh root instead, and the adapter helpers stop every
 * hook bridge the test started, then remove the root, after each test. The root is under
 * the short `/tmp`, not the long macOS `os.tmpdir()`: a socket path there must clear the
 * ~104-byte cap. Only the socket-home module is redirected, never `TMPDIR` (see
 * `setSocketHomeRootForTests`).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { type MockInstance, vi } from "vitest";
import { HookBridgeServer } from "../../src/bridge/server.ts";
import {
  resetSocketHomeRootForTests,
  setSocketHomeRootForTests,
} from "../../src/state/socket-home.ts";

let root: string | undefined;
const bridges = new Set<HookBridgeServer>();
let tracking: MockInstance<HookBridgeServer["start"]> | undefined;

/** Records every hook bridge the current test starts, so cleanup can stop it. */
function trackBridges(): void {
  if (tracking) return;
  const start = HookBridgeServer.prototype.start;
  tracking = vi.spyOn(HookBridgeServer.prototype, "start").mockImplementation(function (
    this: HookBridgeServer,
  ) {
    bridges.add(this);
    return start.call(this);
  });
}

/**
 * Mints the current test's socket homes under its own private root and returns that
 * root, the same one on every call until `removeFakeSocketHomes`.
 */
export function isolateFakeSocketHomes(): string {
  root ??= mkdtempSync("/tmp/elwood_test_sock-");
  setSocketHomeRootForTests(root);
  trackBridges();
  return root;
}

/**
 * Stops every hook bridge the current test started, restores the real socket-home root,
 * and removes the test's private one. With no private root it removes nothing.
 */
export async function removeFakeSocketHomes(): Promise<void> {
  const started = [...bridges];
  bridges.clear();
  await Promise.allSettled(started.map((bridge) => bridge.stop()));
  tracking?.mockRestore();
  tracking = undefined;
  resetSocketHomeRootForTests();
  const made = root;
  root = undefined;
  if (made) rmSync(made, { recursive: true, force: true });
}
