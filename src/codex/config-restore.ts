/**
 * Compensates the Codex CLI persisting picker selections into config.toml.
 * Implements PRD §5.3 setModel restore and C-CODEX-14.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type ConfigRestoreOutcome = "restored" | "skipped" | "unchanged";

export function codexConfigPath(): string {
  return join(process.env["CODEX_HOME"] ?? join(homedir(), ".codex"), "config.toml");
}

export function snapshotCodexConfig(): string | undefined {
  const path = codexConfigPath();
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

/**
 * Restores the snapshot if and only if the file now differs solely in the
 * root-level model keys the picker writes. Anything else — a concurrent user
 * edit, a missing snapshot, an unexpected rewrite — skips the restore so
 * user-owned configuration is never clobbered.
 */
export function restoreCodexConfig(snapshot: string | undefined): ConfigRestoreOutcome {
  const path = codexConfigPath();
  if (snapshot === undefined || !existsSync(path)) return "skipped";
  const current = readFileSync(path, "utf8");
  if (current === snapshot) return "unchanged";
  if (withoutRootModelKeys(current) !== withoutRootModelKeys(snapshot)) return "skipped";
  writeFileSync(path, snapshot);
  return "restored";
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
