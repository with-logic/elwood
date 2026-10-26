/**
 * Real-Codex proof that `teardown()` and `kill()` reap Codex's shell-snapshot shell
 * (PRD §5.3, C-LIFE-10). Soon after it starts, Codex snapshots the user's shell
 * environment with `/bin/zsh -lc <script>`, run in a session of its own. The script
 * sources the user's `.zshrc`, so a slow profile keeps that shell running. A shutdown
 * in that window used to leave it, and whatever the profile started, running under
 * PID 1: the leader-group SIGKILL cannot reach another session. The detached walk
 * reaps it. A graceful `stop()` reaps it too, though Codex exits on SIGTERM within the
 * graceful window: it records the shell while Codex runs and reaps it after.
 */

import assert from "node:assert/strict";
import { randomInt } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { childPids } from "../../dev/child-lookup.ts";
import { type CodexSessionApi, startCodex } from "../../src/index.ts";
import { killGroupsWhoseCommandHas, pidExists, processRows } from "../helpers/process-liveness.ts";
import {
  cleanup,
  codexAuthMissing,
  makeProject,
  sandboxedCodexHome,
  skipIf,
  skipReason,
  waitFor,
} from "./helpers.ts";

/**
 * A `.zshrc` that holds only a non-interactive shell, so only the snapshot waits: the
 * PTY's login shell is interactive. The random fraction of a second makes the `sleep`
 * command line name only this test's process, for cleanup.
 */
function slowProfile(dir: string): string {
  const marker = `sleep 120.${randomInt(1e9).toString().padStart(9, "0")}`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".zshrc"), `[[ -o interactive ]] || ${marker}\n`);
  return marker;
}

/** The snapshot shell holding `marker`, once it runs in a group of its own under a leader. */
function snapshotShell(marker: string, leaders: readonly number[]) {
  const table = processRows();
  const row = (pid: number) => table.find((entry) => entry.pid === pid);
  const sleeper = table.find((entry) => entry.command.includes(marker));
  const shell = sleeper === undefined ? undefined : row(sleeper.ppid);
  if (shell === undefined || !shell.command.startsWith("/bin/zsh -lc ")) return undefined;
  if (shell.pgid !== shell.pid || !leaders.includes(shell.ppid)) return undefined;
  return { shell: shell.pid, sleeper: sleeper!.pid };
}

/**
 * Shuts Codex down with `verb` while its snapshot shell runs, waits for the shell and its
 * child to be gone, and resolves to how many processes from the slow profile survived.
 */
async function shutDownDuringSnapshot(verb: "kill" | "stop" | "teardown"): Promise<number> {
  const project = makeProject("codex");
  const sandbox = sandboxedCodexHome(project, "check_for_update_on_startup = false\n");
  const previousZdotdir = process.env["ZDOTDIR"];
  const zdotdir = join(project.cwd, "zdotdir");
  const marker = slowProfile(zdotdir);
  process.env["ZDOTDIR"] = zdotdir; // The PTY inherits it, and so does the snapshot.
  const before = new Set(childPids(process.pid));
  let session: CodexSessionApi | undefined;
  try {
    // Codex refuses the model before using any quota; the snapshot runs regardless.
    session = await startCodex({
      cwd: project.cwd,
      stateDir: project.stateDir,
      autotrust: true,
      autoupdate: false,
      model: "gpt-elwood-nonexistent-acceptance-probe",
    });
    const leaders = childPids(process.pid).filter((pid) => !before.has(pid));
    const held = await waitFor(() => snapshotShell(marker, leaders), "snapshot shell", 60_000);
    await session[verb]();
    for (const pid of [held.shell, held.sleeper]) {
      await waitFor(() => (pidExists(pid) ? undefined : true), `pid ${pid} reaped`, 10_000);
    }
    return killGroupsWhoseCommandHas(marker);
  } finally {
    if (previousZdotdir === undefined) delete process.env["ZDOTDIR"];
    else process.env["ZDOTDIR"] = previousZdotdir;
    await cleanup(session);
    sandbox.dispose();
    killGroupsWhoseCommandHas(marker);
  }
}

for (const verb of ["teardown", "kill", "stop"] as const) {
  test(`C-LIFE-10 ${verb} reaps Codex's shell-snapshot shell while it still runs`, {
    skip: skipIf(skipReason("codex"), codexAuthMissing()),
    timeout: 180_000,
  }, async () => {
    assert.equal(await shutDownDuringSnapshot(verb), 0, "nothing runs from the slow profile");
  });
}
