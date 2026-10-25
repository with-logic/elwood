/**
 * Scratch state for real-agent e2e tests (PRD §12): per-test project roots under
 * tmpdir that are swept after the file's tests finish, and a sandboxed `CODEX_HOME`
 * seeded with only the user's `auth.json` so Codex config persistence (C-CODEX-14)
 * never touches the developer's real `~/.codex`. Claude has no equivalent sandbox:
 * its credentials live in the macOS keychain, so Claude e2e runs use the real
 * `~/.claude` state.
 */

import { chmodSync, copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import type { AgentName } from "./availability.ts";

export type E2eProject = {
  readonly cwd: string;
  readonly stateDir: string;
  sessionDir(id: string): string;
};

export type CodexSandbox = {
  readonly home: string;
  readonly configPath: string;
  /** Restores `CODEX_HOME` and removes the sandbox (including the auth.json copy). */
  dispose(): void;
};

export const codexAuthPath = join(homedir(), ".codex", "auth.json");

const scratchRoots: string[] = [];

// Sweep every project root once the file's tests are done. The prefix deliberately
// does not start with `elwood-` (the socket-home prefix, `src/state/socket-home.ts`),
// so tests that enumerate `elwood-<16hex>` homes under tmpdir never see scratch dirs.
after(() => {
  for (const root of scratchRoots.splice(0)) rmSync(root, { recursive: true, force: true });
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
  return existsSync(codexAuthPath) ? undefined : "no ~/.codex/auth.json for a sandboxed CODEX_HOME";
}

/**
 * Points `CODEX_HOME` at a private directory (mkdtemp makes it 0700) holding a 0600
 * copy of the user's `auth.json` and the given `config.toml`. The directory is a
 * scratch root of its own, outside `project.cwd`, so the credential copy is not in
 * the workspace the agent works in, and the file's sweep removes it if a test never
 * reaches `dispose()`. Tear sessions down BEFORE `dispose()`: it removes the sandbox,
 * so an in-flight session could otherwise rewrite a config nobody is watching. Real
 * `~/.codex` is never read or written beyond the auth copy.
 */
export function sandboxedCodexHome(project: E2eProject, config: string): CodexSandbox {
  if (!existsSync(codexAuthPath)) throw new Error(codexAuthMissing());
  // Named after the project's scratch root so a leftover is attributable to its test.
  const home = mkdtempSync(`${project.cwd}-codex-home-`);
  scratchRoots.push(home);
  const authCopy = join(home, "auth.json");
  copyFileSync(codexAuthPath, authCopy);
  chmodSync(authCopy, 0o600);
  const configPath = join(home, "config.toml");
  writeFileSync(configPath, config);
  const previousHome = process.env["CODEX_HOME"];
  process.env["CODEX_HOME"] = home;
  return {
    home,
    configPath,
    dispose: () => {
      if (previousHome === undefined) delete process.env["CODEX_HOME"];
      else process.env["CODEX_HOME"] = previousHome;
      rmSync(home, { recursive: true, force: true });
    },
  };
}
