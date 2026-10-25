/**
 * The default Codex home for every real-Codex e2e (PRD §12). `npm run test:e2e` loads this
 * module before any test (`--import`), and the shared e2e helpers import it, so a file run
 * on its own gets it too. It points `CODEX_HOME` at a private directory holding only a
 * 0600 copy of the user's `auth.json`. Everything Codex persists while the suite drives
 * it lands there: the `[projects."<cwd>"]` trust entry it writes for each scratch project,
 * model selections, sessions, and logs. The directory is removed when the process exits.
 * The user's own Codex home is read once, for that auth copy, and never written.
 */

import { chmodSync, copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/** Carries the user's own Codex home into `node --test` workers, which inherit the runner's sandbox. */
const userCodexHomeKey = "ELWOOD_E2E_USER_CODEX_HOME";

/** The Codex home the user's own CLI resolves: `CODEX_HOME`, else `~/.codex`. */
export const userCodexHome =
  process.env[userCodexHomeKey] ?? process.env["CODEX_HOME"] ?? join(homedir(), ".codex");
process.env[userCodexHomeKey] = userCodexHome;

/** The user's Codex login, the only file the suite copies out of their Codex home. */
export const codexAuthPath = join(userCodexHome, "auth.json");

/**
 * This process's `CODEX_HOME`. `sandboxedCodexHome` swaps in a per-test home with its own
 * `config.toml` and restores this one. The prefix does not start with `elwood-`, which
 * socket homes use (`src/state/socket-home.ts`).
 */
export const defaultCodexHome = mkdtempSync(join(tmpdir(), "elwood_e2e_codex_home-"));
if (existsSync(codexAuthPath)) {
  const authCopy = join(defaultCodexHome, "auth.json");
  copyFileSync(codexAuthPath, authCopy);
  chmodSync(authCopy, 0o600);
}
process.env["CODEX_HOME"] = defaultCodexHome;
process.on("exit", () => rmSync(defaultCodexHome, { recursive: true, force: true }));
