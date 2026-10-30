/**
 * Removing a Codex home stops what still runs from it first (PRD §12, C-E2E-03). Codex 0.164
 * can start an app-server daemon for its `CODEX_HOME` that outlives the TUI and keeps writing
 * into the home (docs/cli-behavior.md, "Codex 0.164 starts an app-server daemon per
 * `CODEX_HOME`"). Its start is not predictable from a TUI launch, so these tests start it with
 * `codex app-server daemon start`, which starts the same daemon and updater every time.
 */

import assert from "node:assert/strict";
import { type ChildProcess, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loginShellCommand, userShell } from "../../src/runtime/shell.ts";
import type { ProcessRow } from "../helpers/process-liveness.ts";
import { codexLaunches, endCodexTest } from "./codex-test-end.ts";
import {
  codexAuthMissing,
  makeProject,
  sandboxedCodexHome,
  skipIf,
  skipReason,
} from "./helpers.ts";
import {
  cleanFixture,
  cleanUp,
  runWithCleanup,
  stillRunning,
} from "./scratch-processes/cleanup.ts";
import { scratchTreeReady, spawnScratchTree } from "./scratch-processes/fixture.ts";
import { processesUnder, stopProcessesUnder, TERM_GRACE_MS } from "./scratch-processes.ts";

/** A daemon start first installs a copy of the CLI, about 260 MB, into the home. */
const DAEMON_START_TIMEOUT_MS = 60_000;
/** Starts the app-server daemon and its updater for `home`; returns what runs from the home. */
function startDaemon(home: string, cwd: string) {
  const started = spawnSync(userShell(), loginShellCommand("exec codex app-server daemon start"), {
    cwd,
    env: { ...process.env, CODEX_HOME: home },
    encoding: "utf8",
    timeout: DAEMON_START_TIMEOUT_MS,
  });
  return { output: `${started.stdout}\n${started.stderr}`, running: processesUnder(home) };
}

/** The daemon's two processes, `codex app-server --listen ...` and its updater loop. */
const daemonOf = (rows: readonly ProcessRow[]) =>
  rows.filter((row) => row.command.includes(" app-server "));

test("C-E2E-03 removing a Codex sandbox stops the app-server daemon Codex started for it", {
  skip: skipIf(skipReason("codex"), codexAuthMissing()),
}, async () => {
  const project = makeProject("codex");
  const sandbox = sandboxedCodexHome(project, "check_for_update_on_startup = false\n");
  let daemon: readonly ProcessRow[] = [];
  await runWithCleanup(async () => {
    const { output, running } = startDaemon(sandbox.home, project.cwd);
    daemon = daemonOf(running);
    assert.match(output, /"status":"started"/);
    assert.equal(daemon.length, 2, "the daemon and its updater loop run from the sandbox");
    await endCodexTest({ sessions: [], sandbox, launches: codexLaunches(), failure: undefined });
    assert.deepEqual(stillRunning(daemon), [], "the daemon outlived its sandbox");
    assert.equal(existsSync(sandbox.home), false, "the sandbox is gone");
  }, [() => cleanUp(sandbox.home, daemon)]);
});

test("C-E2E-03 the suite's default Codex home stops its app-server daemon when the run exits", {
  skip: skipIf(skipReason("codex"), codexAuthMissing()),
}, async () => {
  // The home is reported before the daemon starts, so this test can clean up after a run
  // that never reached its exit hook.
  const script = `
    import { spawnSync } from "node:child_process";
    import { processesUnder } from "./tests/e2e/scratch-processes.ts";
    import { loginShellCommand, userShell } from "./src/runtime/shell.ts";
    const home = process.env.CODEX_HOME;
    console.log(JSON.stringify({ home }));
    const start = loginShellCommand("exec codex app-server daemon start");
    spawnSync(userShell(), start, { stdio: "ignore", timeout: ${DAEMON_START_TIMEOUT_MS} });
    console.log(JSON.stringify({ daemon: processesUnder(home) }));
  `;
  const run = spawnSync(
    process.execPath,
    ["--no-warnings", "--import", "./tests/e2e/codex-home.ts", "--input-type=module", "-e", script],
    { encoding: "utf8", timeout: 2 * DAEMON_START_TIMEOUT_MS },
  );
  const reports = run.stdout.split("\n").flatMap((line) => {
    try {
      return [JSON.parse(line) as { home?: string; daemon?: readonly ProcessRow[] }];
    } catch {
      return [];
    }
  });
  const home = reports.find((report) => report.home !== undefined)?.home;
  const daemon = reports.find((report) => report.daemon !== undefined)?.daemon ?? [];
  await runWithCleanup(() => {
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    assert.equal(daemonOf(daemon).length, 2, "the daemon and its updater loop ran from the home");
    assert.deepEqual(stillRunning(daemon), [], "the daemon outlived the run's Codex home");
    assert.equal(home !== undefined && existsSync(home), false, "the run's Codex home is gone");
  }, [() => cleanUp(home, daemon)]);
});

test("C-E2E-03 stopping reaches a descendant that ignores SIGTERM after its parent exits", async () => {
  const dir = mkdtempSync(join(tmpdir(), "elwood_e2e_scratch_processes-"));
  // Names both fixture processes, for cleanup: the child's command line names nothing in `dir`.
  const marker = `elwood-scratch-fixture-${randomUUID()}`;
  let parent: ChildProcess | undefined;
  await runWithCleanup(async () => {
    parent = spawnScratchTree(dir, marker);
    await scratchTreeReady(parent);
    const [line] = (await once(parent.stdout as NodeJS.ReadableStream, "data")) as [Buffer];
    const childPid = Number(line.toString().trim());
    const found = processesUnder(dir);
    assert.deepEqual(found.map((row) => row.pid).sort(), [parent.pid, childPid].sort());
    const started = Date.now();
    stopProcessesUnder(dir);
    assert.ok(Date.now() - started >= TERM_GRACE_MS, "the child needed SIGKILL after the grace");
    assert.deepEqual(stillRunning(found), [], "a process from the directory is still running");
  }, [() => cleanFixture(parent, marker, dir)]);
});
