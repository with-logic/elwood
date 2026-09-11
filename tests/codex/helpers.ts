/**
 * Codex adapter test harness: installs the PTY/command/reaper seams (PRD §13) with the
 * shared `FakePty`, tracks the ptys and reaped process groups a test can inspect, drives
 * readiness through the `SessionStart` hook (C-API-28), and hands out scratch dirs that
 * are removed after each test.
 */

import { afterEach } from "vitest";
import { resetCodexPreflightCacheForTests } from "../../src/codex/preflight.ts";
import { resetCodexSessionSeamsForTests } from "../../src/codex/session/index.ts";
import {
  resetRuntimeSeamsForTests,
  setCommandRunnerForTests,
  setPlatformForTests,
  setPtyFactoryForTests,
} from "../../src/runtime/seams.ts";
import {
  resetGroupKillerForTests,
  setGroupKillerForTests,
} from "../../src/runtime/shutdown/reap-tree.ts";
import {
  resetStartupWaitMsForTests,
  setStartupWaitMsForTests,
} from "../../src/runtime/startup/index.ts";
import { resetPreflightCacheForTests } from "../../src/runtime/update/once.ts";
import { createScratchRegistry, FakePty } from "../helpers/fake-pty.ts";

export { type BridgeReply, dispatchRaw, FakePty, readBridgeScript } from "../helpers/fake-pty.ts";

export const ptys: FakePty[] = [];
/** Process-group ids that session teardown asked the reaper to SIGKILL. */
export const reapedGroups: number[] = [];

const versionOk =
  (supportsHookTrustBypass: boolean) => (_command: string, args: readonly string[]) =>
    args.join(" ").includes("--help")
      ? {
          status: 0,
          stdout: supportsHookTrustBypass ? "codex --dangerously-bypass-hook-trust\n" : "codex\n",
          stderr: "",
        }
      : { status: 0, stdout: "codex-cli 0.132.0\n", stderr: "" };
const scratch = createScratchRegistry("elwood_test_codex-");

afterEach(() => scratch.removeAll());

export function installFakes(options: { readonly supportsHookTrustBypass?: boolean } = {}): void {
  setPlatformForTests("darwin");
  setCommandRunnerForTests(versionOk(options.supportsHookTrustBypass ?? true));
  setStartupWaitMsForTests(25);
  setGroupKillerForTests({ killGroup: (pgid) => reapedGroups.push(pgid) });
  setPtyFactoryForTests((options) => {
    const pty = new FakePty(options, 1000 + ptys.length);
    ptys.push(pty);
    return pty;
  });
}

export function resetFakes(): void {
  resetRuntimeSeamsForTests();
  resetStartupWaitMsForTests();
  resetPreflightCacheForTests();
  resetCodexPreflightCacheForTests();
  resetCodexSessionSeamsForTests();
  resetGroupKillerForTests();
  ptys.length = 0;
  reapedGroups.length = 0;
}

/** A fresh scratch directory (removed after the current test). */
export function tempDir(): string {
  return scratch.make();
}

/**
 * Drives a fake Codex session to initial readiness the way the real CLI does:
 * via its `SessionStart` hook (C-API-28). The rendered composer marker is a
 * boot-time placeholder and no longer releases the first queued message, so
 * tests dispatch the readiness hook instead of emitting a `›` frame.
 */
export function becomeReady(
  elwoodSessionId: string,
  cwd: string,
  overrides: Record<string, unknown> = {},
) {
  return ptys[0]!.dispatchHook(elwoodSessionId, {
    hook_event_name: "SessionStart",
    session_id: "codex-1",
    cwd,
    model: "gpt-5.3-codex",
    source: "startup",
    ...overrides,
  });
}
