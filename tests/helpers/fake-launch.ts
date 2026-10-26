/**
 * Both CLIs, faked through the runtime seams, for tests of what a start or resume does around
 * its launch directory and state (PRD §8.1, C-API-61, C-STATE-14): probes succeed and every
 * PTY spawn fails, so nothing launches.
 */

import { resetCodexPreflightCacheForTests } from "../../src/codex/preflight.ts";
import {
  resetRuntimeSeamsForTests,
  setCommandRunnerForTests,
  setPlatformForTests,
  setPtyFactoryForTests,
} from "../../src/runtime/seams.ts";
import { resetPreflightCacheForTests } from "../../src/runtime/update/once.ts";

/**
 * Fakes both CLIs: the first probe runs `duringPreflight`, and every PTY spawn records its
 * directory, runs `atSpawn`, and fails. Returns the directories spawns were asked for.
 */
export function fakeLaunch(duringPreflight = () => {}, atSpawn = () => {}): string[] {
  const launchedIn: string[] = [];
  let first = true;
  setPlatformForTests("darwin");
  setCommandRunnerForTests((_command, args) => {
    if (first) duringPreflight();
    first = false;
    const line = args.join(" ");
    const help = "codex --dangerously-bypass-hook-trust\n";
    const version = line.includes("codex") ? "codex-cli 0.132.0\n" : "2.1.144\n";
    return { status: 0, stdout: line.includes("--help") ? help : version, stderr: "" };
  });
  setPtyFactoryForTests((options) => {
    launchedIn.push(options.cwd);
    atSpawn();
    throw new Error("no PTY in this test");
  });
  return launchedIn;
}

/** Forgets cached probe results, so the next start or resume probes again. */
export function resetPreflightCaches(): void {
  resetPreflightCacheForTests();
  resetCodexPreflightCacheForTests();
}

/** Restores the real seams and forgets cached probe results. */
export function resetFakeLaunch(): void {
  resetRuntimeSeamsForTests();
  resetPreflightCaches();
}
