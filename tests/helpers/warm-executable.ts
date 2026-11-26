/**
 * Writes a test's fake executable with its first exec already paid, so a short bound in the
 * harness times only the fake's own work (PRD §12; C-E2E-23, C-STATS-03).
 *
 * macOS checks a newly written executable the first time it is exec'd. On an idle machine the
 * check costs about 200 ms, against 5 ms for every later exec, and it grows with load: with a
 * few processes starting at once it took 1.2 s. A full parallel run once pushed the fake
 * keychain's first exec past the 5 s bound `keychainLogin` gives it. The check is paid once
 * per file and survives a rewrite in place. So this writes a script that only exits, execs it
 * once, and then writes the fake's body over it. The fake's body never runs here, so the
 * warm-up records nothing. The exec is bounded too, since the check before the script starts
 * is the slow part: a warm-up that fails or runs out leaves the fake as it was, written,
 * executable and cold, for the fake's own bounded exec to pay.
 */

import { type SpawnSyncOptions, spawnSync } from "node:child_process";
import { chmodSync, writeFileSync } from "node:fs";

/** What runs on the warm-up exec: a fixed script that exits at once. */
const exitAtOnce = "#!/bin/sh\nexit 0\n";

/** Far past any first exec measured, so only a stalled check runs it out. */
export const warmUpBoundMs = 30_000;

/** Runs the warm-up exec of `path` with `options`; its outcome changes nothing. */
export type WarmUpRun = (path: string, options: SpawnSyncOptions) => void;

const runOnce: WarmUpRun = (path, options) => {
  spawnSync(path, [], options);
};

/** Writes `body` to `path` as an executable only the user can run, its first exec already paid. */
export function writeWarmExecutable(path: string, body: string, run = runOnce): void {
  writeFileSync(path, exitAtOnce);
  chmodSync(path, 0o700);
  run(path, { stdio: "ignore", timeout: warmUpBoundMs });
  writeFileSync(path, body);
}
