/**
 * Shared setup for the real-Codex login-shell `CODEX_HOME` e2e files: a private `ZDOTDIR` whose
 * startup files source the user's own and then export a `CODEX_HOME`, around a test that ends
 * through `runCodexTest`, then stops anything still running from the homes under its projects.
 * Supports PRD §4.2 and C-CODEX-24. The user's startup files and real
 * `~/.codex` are only read, never written.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { basename, join } from "node:path";
import { type CodexTestScope, runCodexTest } from "./codex-test-end.ts";
import { codexAuthMissing, skipIf, skipReason } from "./helpers.ts";
import { keepScratch } from "./scratch.ts";
import { stopProcessesUnder } from "./scratch-processes.ts";

// Launch, readiness, and up to three picker operations, none of which runs a model turn.
export const loginShellTestTimeoutMs = 240_000;
export const baseConfig = 'model_reasoning_effort = "medium"\n';

/**
 * A zsh test true only in a session's launch shell: in a terminal, with the session id Elwood
 * sets for it. A probe shell has neither.
 */
export const inSession = '[[ -t 0 && -n "$ELWOOD_SESSION_ID" ]]';

export const loginShellSkip = skipIf(
  skipReason("codex"),
  codexAuthMissing(),
  basename(userInfo().shell ?? "") !== "zsh" && "the login shell is not zsh",
);

/**
 * Runs a real-Codex test's body with `ZDOTDIR` pointing at startup files under the sandbox's
 * project that source the user's own and finally run `exportLine`, and ends it through
 * `runCodexTest`: the projects and homes stay unless every Codex process is confirmed gone.
 * `ZDOTDIR` is restored either way, so later tests launch through the user's own files.
 */
export async function runLoginShellTest(
  scope: CodexTestScope,
  exportLine: string,
  body: () => Promise<void>,
): Promise<void> {
  const restoreZdotdir = useExportingZdotdir(scope.sandbox.project.cwd, exportLine);
  const failures: unknown[] = [];
  try {
    await runCodexTest(scope, body);
  } catch (error) {
    failures.push(error);
  } finally {
    restoreZdotdir();
  }
  failures.push(...stopUnderProjects(scope));
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "Codex login-shell test failed");
}

/**
 * The homes these tests export sit under their projects, where the sandbox's own disposal does
 * not look, and Codex can leave a daemon running from one. Stops whatever still runs from the
 * projects; a project something will not stop from is kept, and its failure returned.
 */
function stopUnderProjects(scope: CodexTestScope): unknown[] {
  const projects = [scope.sandbox.project, ...(scope.otherProjects ?? [])];
  const failures: unknown[] = [];
  for (const { cwd } of projects) {
    try {
      stopProcessesUnder(cwd);
    } catch (error) {
      keepScratch(cwd);
      failures.push(error);
    }
  }
  return failures;
}

/**
 * Points `ZDOTDIR` at a directory under `root` whose files source the user's own zsh startup
 * files and finally run `exportLine`. Returns the function that restores `ZDOTDIR`.
 */
function useExportingZdotdir(root: string, exportLine: string): () => void {
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
