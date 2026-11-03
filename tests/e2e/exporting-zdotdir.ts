/**
 * Startup files of a real-CLI e2e test's own, for the zsh login shell a CLI launches through:
 * a private `ZDOTDIR` whose files source the user's own, so the CLI resolves as usual, and
 * finally run the test's line. Supports PRD §4.2 and §12 (C-CODEX-24, C-E2E-23, C-E2E-24).
 * The user's startup files are only read, never written.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { basename, join } from "node:path";

/** Why a test that needs these startup files cannot run here: only zsh reads them. */
export const notZsh = basename(userInfo().shell ?? "") !== "zsh" && "the login shell is not zsh";

/**
 * Points `ZDOTDIR` at a directory under `root` whose files source the user's own zsh startup
 * files and finally run `exportLine`. Returns the function that restores `ZDOTDIR`.
 */
export function useExportingZdotdir(root: string, exportLine: string): () => void {
  const dir = join(root, "zdotdir");
  mkdirSync(dir, { recursive: true });
  for (const file of [".zshenv", ".zprofile", ".zshrc", ".zlogin"]) {
    const own = `[[ -f "$HOME/${file}" ]] && source "$HOME/${file}"\n`;
    writeFileSync(join(dir, file), own + (file === ".zlogin" ? `${exportLine}\n` : ""));
  }
  const previous = process.env["ZDOTDIR"];
  process.env["ZDOTDIR"] = dir;
  return () => {
    if (previous === undefined) delete process.env["ZDOTDIR"];
    else process.env["ZDOTDIR"] = previous;
  };
}
