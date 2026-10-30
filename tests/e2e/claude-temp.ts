/**
 * Claude's temp root as the e2e suite sees it (PRD §12, C-E2E-23, C-E2E-18). Claude 2.1.310
 * keeps its temp files under `<root>/claude-<uid>`, where the root is `CLAUDE_CODE_TMPDIR`,
 * or `/tmp` when that is unset, with one folder per working directory. Importing this has no
 * side effects, so the question sandbox shares it without setting up an e2e Claude home.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** The variable naming Claude's temp root. */
export const claudeTempKey = "CLAUDE_CODE_TMPDIR";

/**
 * Whether `key` is one of the variables a parent Claude session sets for the processes it
 * starts, which the suite drops so that a Claude it starts behaves as it would for a user.
 * The temp root is not one of them: the suite sets it.
 */
export function isNestedClaudeVariable(key: string): boolean {
  return key === "CLAUDECODE" || (key.startsWith("CLAUDE_CODE_") && key !== claudeTempKey);
}

/**
 * The temp folder Claude keeps for the working directory at real path `cwd`: the path with
 * each character other than a letter or digit replaced by "-".
 */
export function claudeTempFolder(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

/** `[folder]` when temp root `root` holds that per-user temp folder, else `[]`. */
export function claudeTempFoldersNamed(root: string, folder: string): string[] {
  const dir = join(root, `claude-${process.getuid?.() ?? 0}`);
  return existsSync(dir) ? readdirSync(dir).filter((name) => name === folder) : [];
}
