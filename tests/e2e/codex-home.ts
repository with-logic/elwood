/**
 * The default Codex home for every real-Codex e2e (PRD §12). `npm run test:e2e` loads this
 * module before any test (`--import`), and the shared e2e helpers import it, so a file run
 * on its own gets it too. It points `CODEX_HOME` at a private directory holding only a
 * 0600 copy of the user's `auth.json`, and removes it when the process exits, once whatever
 * still runs from it has stopped (`stopProcessesUnder`). A test that needs its own
 * `config.toml` swaps in another private home (`sandboxedCodexHome`) and restores this one. Whatever Codex persists while the suite drives it, such as the
 * `[projects."<cwd>"]` trust entry for each scratch project, model selections, sessions,
 * and logs, lands in whichever private home is active. The user's own Codex home is read
 * once, for the auth copy, and never written.
 */

import { chmodSync, copyFileSync, existsSync, rmSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { privateTempDir } from "../helpers/private-temp.ts";
import { stopProcessesUnder } from "./scratch-processes.ts";

/** Carries the user's own Codex home into `node --test` workers, which inherit the runner's sandbox. */
const userCodexHomeKey = "ELWOOD_E2E_USER_CODEX_HOME";

/** The Codex home the user's own CLI resolves: `CODEX_HOME`, else `~/.codex`. */
const userCodexHome =
  process.env[userCodexHomeKey] ?? process.env["CODEX_HOME"] ?? join(homedir(), ".codex");
process.env[userCodexHomeKey] = userCodexHome;

/** The user's Codex login, the only file the suite copies out of their Codex home. */
export const userCodexAuthPath = join(userCodexHome, "auth.json");

/** Seeds the private Codex home `home` with a 0600 copy of the user's Codex login. */
export function copyCodexAuth(home: string): void {
  const copy = join(home, "auth.json");
  copyFileSync(userCodexAuthPath, copy);
  chmodSync(copy, 0o600);
}

/**
 * This process's default `CODEX_HOME`. Its removal is registered before the auth copy,
 * so a failed copy leaves nothing behind. The prefix does not start with `elwood-`,
 * which socket homes use (`src/state/socket-home.ts`).
 */
export const defaultCodexHome = privateTempDir("elwood_e2e_codex_home-", userCodexHome);
// Codex may have started an app-server daemon for this home, which outlives the test run.
// A home that something may still run from is kept, and the run fails. The hook reports
// that instead of throwing: a throwing `exit` listener skips every listener after it, and
// those remove the run's other private directories.
process.on("exit", () => {
  try {
    stopProcessesUnder(defaultCodexHome);
    rmSync(defaultCodexHome, { recursive: true, force: true });
  } catch (error) {
    process.exitCode = 1;
    const reason = error instanceof Error ? error.message : String(error);
    try {
      writeSync(2, `Could not clean up the e2e Codex home ${defaultCodexHome}: ${reason}\n`);
    } catch {
      // stderr is closed: the exit code still fails the run.
    }
  }
});
if (existsSync(userCodexAuthPath)) copyCodexAuth(defaultCodexHome);
process.env["CODEX_HOME"] = defaultCodexHome;
