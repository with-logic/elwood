/**
 * A private directory one e2e run shares between its `node --test` runner and the test-file
 * workers it starts (PRD §12). `npm run test:e2e` loads this module in the runner first
 * (`--import`), which hands the directory to its workers in `ELWOOD_E2E_RUN_DIR`. The process
 * that made the directory removes it when it exits, so a run leaves nothing in the temp dir.
 * A process started without one, such as a file run on its own, makes its own.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const runDirKey = "ELWOOD_E2E_RUN_DIR";

function makeRunDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "elwood_e2e_run-"));
  process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
  process.env[runDirKey] = dir;
  return dir;
}

const inherited = process.env[runDirKey];

/** This run's shared directory: the runner's, else one this process made and removes. */
export const e2eRunDir = inherited && existsSync(inherited) ? inherited : makeRunDir();
