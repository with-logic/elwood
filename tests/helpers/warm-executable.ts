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
 * warm-up records nothing and cannot hang. A warm-up that fails leaves the fake as it was:
 * written, executable, and cold.
 */

import { spawnSync } from "node:child_process";
import { chmodSync, writeFileSync } from "node:fs";

/** What runs on the warm-up exec: a fixed script that exits at once. */
const exitAtOnce = "#!/bin/sh\nexit 0\n";

/** Writes `body` to `path` as an executable only the user can run, its first exec already paid. */
export function writeWarmExecutable(path: string, body: string): void {
  writeFileSync(path, exitAtOnce);
  chmodSync(path, 0o700);
  spawnSync(path, [], { stdio: "ignore" });
  writeFileSync(path, body);
}
