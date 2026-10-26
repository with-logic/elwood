/**
 * Scratch state for real-agent e2e tests (PRD §12): per-test project roots under
 * tmpdir that are swept after the file's tests finish, and a per-test `CODEX_HOME`
 * seeded with only the user's `auth.json` and a given `config.toml`, for Codex config
 * persistence (C-CODEX-14). Importing this module installs the suite's default Codex
 * home (`codex-home.ts`), so no Codex e2e touches the developer's own Codex home.
 * Claude has no equivalent sandbox: its credentials live in the macOS keychain, so
 * Claude e2e runs use the real `~/.claude` state.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import type { AgentName } from "./availability.ts";
import { copyCodexAuth, userCodexAuthPath } from "./codex-home.ts";
import { stopProcessesUnder } from "./scratch-processes.ts";

export type E2eProject = {
  readonly cwd: string;
  readonly stateDir: string;
  sessionDir(id: string): string;
};

export type CodexSandbox = {
  /** The project the sandbox was made for, whose scratch it is named after. */
  readonly project: E2eProject;
  readonly home: string;
  readonly configPath: string;
  /**
   * Restores `CODEX_HOME`, stops what still runs from the sandbox, such as the app-server
   * daemon Codex may start for it (`stopProcessesUnder`), and removes the sandbox (including
   * the auth.json copy). When something there will not stop, or the removal fails, it throws
   * and keeps the sandbox and its project past the file's sweep.
   */
  dispose(): void;
  /** Restores `CODEX_HOME` and leaves the sandbox, which a Codex process may still use. */
  restoreHome(): void;
};

const scratchRoots: string[] = [];

// Sweep every project root once the file's tests are done, after stopping what still runs
// from it: a test that failed before its `dispose()` can leave an agent, or the daemon
// Codex starts for a home. A root that will not stop is kept, and the sweep reports it
// after removing the rest. The prefix deliberately does not start with `elwood-` (the
// socket-home prefix, `src/state/socket-home.ts`), so tests that enumerate
// `elwood-<16hex>` homes under tmpdir never see scratch dirs.
after(() => {
  const errors: unknown[] = [];
  for (const root of scratchRoots.splice(0)) {
    try {
      if (existsSync(root)) stopProcessesUnder(root);
      rmSync(root, { recursive: true, force: true });
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, "Scratch sweep kept roots in use");
});

export function makeProject(agent: AgentName): E2eProject {
  const root = mkdtempSync(join(tmpdir(), `elwood_e2e_${agent}-`));
  scratchRoots.push(root);
  writeFileSync(join(root, "AGENTS.md"), "Answer directly. Do not modify files unless asked.\n");
  return {
    cwd: root,
    stateDir: join(root, ".state"),
    sessionDir: (id: string) => join(root, ".state", "sessions", id),
  };
}

/**
 * Keeps scratch roots past the file's sweep, for a test that could not confirm its agent
 * exited: a surviving process may still be using them, and they stay for diagnosis.
 */
export function keepScratch(...roots: readonly string[]): void {
  for (const root of roots) {
    const index = scratchRoots.indexOf(root);
    if (index >= 0) scratchRoots.splice(index, 1);
  }
}

/** Skip reason when the user has no Codex login to seed a sandboxed `CODEX_HOME` from. */
export function codexAuthMissing(): string | undefined {
  if (existsSync(userCodexAuthPath)) return undefined;
  return "no auth.json in the user's Codex home for a sandboxed CODEX_HOME";
}

/**
 * Creates the private Codex home `home`: a 0600 copy of the user's `auth.json` and the given
 * `config.toml`, whose path it returns. Filesystem only; callers decide who names the home.
 */
export function seedCodexHome(home: string, config: string): string {
  if (!existsSync(userCodexAuthPath)) throw new Error(codexAuthMissing());
  mkdirSync(home, { recursive: true, mode: 0o700 });
  copyCodexAuth(home);
  const configPath = join(home, "config.toml");
  writeFileSync(configPath, config);
  return configPath;
}

/**
 * Points `CODEX_HOME` at a private directory (mkdtemp makes it 0700) holding a 0600
 * copy of the user's `auth.json` and the given `config.toml`. The directory is a
 * scratch root of its own, outside `project.cwd`, so the credential copy is not in
 * the workspace the agent works in, and the file's sweep removes it if a test never
 * reaches `dispose()`. Tear sessions down BEFORE `dispose()`: it removes the sandbox,
 * so an in-flight session could otherwise rewrite a config nobody is watching.
 * `dispose()` restores the suite's default home (`codex-home.ts`). The user's own Codex
 * home is never read or written beyond the auth copy.
 */
export function sandboxedCodexHome(project: E2eProject, config: string): CodexSandbox {
  // Named after the project's scratch root so a leftover is attributable to its test.
  const home = mkdtempSync(`${project.cwd}-codex-home-`);
  scratchRoots.push(home);
  const configPath = seedCodexHome(home, config);
  const previousHome = process.env["CODEX_HOME"];
  process.env["CODEX_HOME"] = home;
  const restoreHome = () => {
    if (previousHome === undefined) delete process.env["CODEX_HOME"];
    else process.env["CODEX_HOME"] = previousHome;
  };
  return {
    project,
    home,
    configPath,
    dispose: () => {
      restoreHome();
      try {
        stopProcessesUnder(home);
        rmSync(home, { recursive: true, force: true });
      } catch (error) {
        // Kept for diagnosis, and out of the file's sweep, which would race what still runs.
        keepScratch(project.cwd, home);
        throw error;
      }
    },
    restoreHome,
  };
}
