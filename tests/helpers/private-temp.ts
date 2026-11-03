/**
 * Private temp directories for the test suites' stand-in homes (PRD §12, C-E2E-22,
 * C-E2E-23). A temp root at or inside the user's Codex home or Claude config dir would put
 * a test's state there, so creation fails closed instead. Removal takes only a directory
 * this module created.
 */

import { mkdtempSync, realpathSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * Creates `<tmpdir>/<prefix>XXXXXX`, refusing a temp root at or inside `userHome`, the
 * user's directory that `label` names.
 */
export function privateTempDir(prefix: string, userHome: string, label = "Codex home"): string {
  const root = tmpdir();
  const offset = relative(realOrResolved(userHome), realOrResolved(root));
  const outside = offset === ".." || offset.startsWith(`..${sep}`) || isAbsolute(offset);
  if (!outside) throw new Error(`TMPDIR is inside the user's ${label}; point it elsewhere`);
  const dir = mkdtempSync(join(root, prefix));
  created.add(dir);
  return dir;
}

/** The directories `privateTempDir` created: the only ones `removeOrReport` removes. */
const created = new Set<string>();

/** Removes `dir`, a `privateTempDir` directory that `label` names, when the process exits. */
export function removeAtExit(dir: string, label: string): void {
  process.on("exit", () => removeOrReport(dir, label));
}

/**
 * Removes `dir`, which `label` names, if `privateTempDir` created it. Any other path, empty
 * included, is left alone. A path left alone, or a removal that fails, fails the run and is
 * reported through `report`, stderr by default, instead of thrown: a throwing `exit`
 * listener skips every listener after it, and those remove the run's other directories.
 */
export function removeOrReport(
  dir: string,
  label: string,
  report: (line: string) => void = (line) => writeSync(2, line),
): void {
  try {
    if (!created.has(dir)) throw new Error("privateTempDir did not create it");
    rmSync(dir, { recursive: true, force: true });
  } catch (error) {
    process.exitCode = 1;
    const reason = error instanceof Error ? error.message : String(error);
    try {
      report(`Could not clean up the e2e ${label} ${JSON.stringify(dir)}: ${reason}\n`);
    } catch {
      // stderr is closed: the exit code still fails the run.
    }
  }
}

/** Symlinks resolved, so `/var` and `/private/var` compare equal; a missing path as given. */
function realOrResolved(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}
