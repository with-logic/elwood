/**
 * Compensates the Codex CLI persisting picker selections into config.toml.
 * Implements PRD §5.3 setModel restore and C-CODEX-14: a compare-and-swap restore
 * of the user's global config that never clobbers concurrent edits, written
 * atomically (sibling temp file + rename) so a crash mid-restore can never leave
 * the user's config truncated. Each session passes the path it fixed at launch.
 */

import {
  chmodSync,
  existsSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ElwoodError, elwoodError, errnoCode } from "../../core/errors.ts";
import { readCodexConfigFile } from "./read.ts";

/**
 * `restored`: the snapshot was written back. `unchanged`: the picker wrote nothing.
 * `skipped`: the file changed in ways other than the root model keys (or vanished),
 * so it was left alone. `no_snapshot`: no config.toml existed before the switch and
 * the picker created one — Elwood has nothing to restore and leaves the new file.
 */
type ConfigRestoreOutcome = "restored" | "skipped" | "unchanged" | "no_snapshot";

/**
 * Resolves the `config.toml` path once per session at launch (`spawnCodexPty`). Only the path
 * is fixed; the file's contents are read for each listing and model switch.
 */
export function codexConfigPath(): string {
  return join(process.env["CODEX_HOME"] ?? join(homedir(), ".codex"), "config.toml");
}

/**
 * Builds the CONTENT-FREE `raw` for a swallowed restore-failure warning: the config
 * path plus a bounded errno code only — never the error message, which could carry
 * credentials or conversation data if the failure came from a public listener. A config
 * read that failed carries its errno as `details.code` (C-CODEX-25).
 */
export function restoreFailureRaw(path: string, error: unknown): string {
  const code = error instanceof ElwoodError ? error.details["code"] : errnoCode(error);
  return `${path} (${typeof code === "string" ? code : "UNKNOWN"})`;
}

/**
 * The config's contents before the picker opens, or `undefined` when it does not exist. One
 * that cannot be read (C-CODEX-25) fails the switch here: Codex would persist its selection
 * into a file Elwood could not restore.
 */
export function snapshotCodexConfig(path: string): string | undefined {
  return readForSwitch(path, "Could not read the Codex config before switching models.");
}

/** The config's contents at the restore, read as `snapshotCodexConfig` reads them. */
export function currentCodexConfig(path: string): string | undefined {
  return readForSwitch(path, "Could not read the Codex config to restore its default model.");
}

function readForSwitch(path: string, message: string): string | undefined {
  try {
    return readCodexConfigFile(path);
  } catch (error) {
    throw elwoodError("model_automation_failed", message, { path, code: errnoCode(error) });
  }
}

/**
 * Restores the snapshot if and only if the file now differs solely in the
 * root-level model keys the picker writes. Anything else — a concurrent user
 * edit, an unexpected rewrite — skips the restore so user-owned configuration is
 * never clobbered. With no snapshot (no config.toml before the switch) a file the
 * picker created is reported as `no_snapshot` rather than misreported as a
 * concurrent edit.
 */
export function restoreCodexConfig({
  path,
  snapshot,
}: {
  readonly path: string;
  readonly snapshot: string | undefined;
}): ConfigRestoreOutcome {
  if (snapshot === undefined) return existsSync(path) ? "no_snapshot" : "unchanged";
  const current = currentCodexConfig(path);
  if (current === undefined) return "skipped";
  if (current === snapshot) return "unchanged";
  if (withoutRootModelKeys(current) !== withoutRootModelKeys(snapshot)) return "skipped";
  writeAtomically(path, snapshot);
  return "restored";
}

/**
 * Replaces `path` via a sibling temp file + rename so the config is never observed
 * empty or partial. A symlinked config.toml is written THROUGH to its resolved
 * target (renaming onto the link path would replace the link itself), and the
 * target's mode is preserved. The temp file is removed on any failure.
 */
function writeAtomically(path: string, contents: string): void {
  const target = realpathSync(path);
  const temp = join(dirname(target), `.config.toml.elwood-${process.pid}-${Date.now()}`);
  try {
    writeFileSync(temp, contents, { mode: 0o600 });
    chmodSync(temp, statSync(target).mode & 0o777);
    renameSync(temp, target);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {} // best-effort cleanup; the original write error is the one that surfaces
    throw error;
  }
}

/**
 * Strips `model` / `model_reasoning_effort` assignments from the root region
 * only. TOML requires root keys to precede the first table header, so keys of
 * the same name inside tables (for example profiles) are left untouched.
 */
function withoutRootModelKeys(text: string): string {
  const lines = text.split("\n");
  const kept: string[] = [];
  let inRoot = true;
  for (const line of lines) {
    if (inRoot && /^\s*\[/.test(line)) inRoot = false;
    if (inRoot && /^\s*(model|model_reasoning_effort)\s*=/.test(line)) continue;
    kept.push(line);
  }
  return kept.join("\n");
}
