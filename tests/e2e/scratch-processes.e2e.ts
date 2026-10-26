/**
 * Removing a Codex home stops what still runs from it first (PRD §12, C-E2E-03). Codex 0.164
 * can start an app-server daemon for its `CODEX_HOME` that outlives the TUI and keeps writing
 * into the home (docs/cli-behavior.md, "Codex 0.164 starts an app-server daemon per
 * `CODEX_HOME`"). Its start is not predictable from a TUI launch, so these tests start it with
 * `codex app-server daemon start`, which starts the same daemon and updater every time.
 */

import assert from "node:assert/strict";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loginShellCommand, userShell } from "../../src/runtime/shell.ts";
import { killIfCommandHas, type ProcessRow, processRows } from "../helpers/process-liveness.ts";
import { codexLaunches, endCodexTest } from "./codex-test-end.ts";
import {
  codexAuthMissing,
  makeProject,
  sandboxedCodexHome,
  skipIf,
  skipReason,
} from "./helpers.ts";
import { processesUnder, stopProcessesUnder, TERM_GRACE_MS } from "./scratch-processes.ts";

/** A daemon start first installs a copy of the CLI, about 260 MB, into the home. */
const DAEMON_START_TIMEOUT_MS = 60_000;

type Identity = Pick<ProcessRow, "pid" | "command">;
const describe = (row: Identity) => `${row.pid} ${row.command}`;

/** Descriptions (`pid command`) of those `rows` still running as the same process. */
function stillRunning(rows: readonly Identity[]): readonly string[] {
  const live = new Set(
    processRows()
      .filter((row) => !row.stat.startsWith("Z"))
      .map(describe),
  );
  return rows.map(describe).filter((row) => live.has(row));
}

/** SIGKILLs each of `rows` still running as the same process: same pid, same command line. */
function endAll(rows: readonly Identity[]): void {
  const wanted = new Set(rows.map(describe));
  for (const row of processRows()) {
    if (!wanted.has(describe(row))) continue;
    try {
      process.kill(row.pid, "SIGKILL");
    } catch {
      // It exited between the read and the kill.
    }
  }
}

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
  try {
    const { output, running } = startDaemon(sandbox.home, project.cwd);
    daemon = daemonOf(running);
    assert.match(output, /"status":"started"/);
    assert.equal(daemon.length, 2, "the daemon and its updater loop run from the sandbox");
    await endCodexTest({ sessions: [], sandbox, launches: codexLaunches(), failure: undefined });
    assert.deepEqual(stillRunning(daemon), [], "the daemon outlived its sandbox");
    assert.equal(existsSync(sandbox.home), false, "the sandbox is gone");
  } finally {
    endAll(daemon);
  }
});

test("C-E2E-03 the suite's default Codex home stops its app-server daemon when the run exits", {
  skip: skipIf(skipReason("codex"), codexAuthMissing()),
}, () => {
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
  try {
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    assert.equal(daemonOf(daemon).length, 2, "the daemon and its updater loop ran from the home");
    assert.deepEqual(stillRunning(daemon), [], "the daemon outlived the run's Codex home");
    assert.equal(home !== undefined && existsSync(home), false, "the run's Codex home is gone");
  } finally {
    endAll(daemon);
    if (home !== undefined && existsSync(home)) {
      stopProcessesUnder(home);
      rmSync(home, { recursive: true, force: true });
    }
  }
});

test("C-E2E-03 stopping reaches a descendant that ignores SIGTERM after its parent exits", async () => {
  const dir = mkdtempSync(join(tmpdir(), "elwood_e2e_scratch_processes-"));
  // Names only the child, whose command line names nothing in `dir`, for cleanup.
  const marker = `elwood-scratch-child-${randomUUID()}`;
  let parent: ChildProcess | undefined;
  let childPid: number | undefined;
  try {
    // The parent exits on SIGTERM; its detached child ignores SIGTERM and is reparented to
    // PID 1 once the parent is gone.
    const childScript = `process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); // ${marker}`;
    writeFileSync(
      join(dir, "parent.mjs"),
      `import { spawn } from "node:child_process";
       const child = spawn(process.execPath, ["-e", ${JSON.stringify(childScript)}], { detached: true, stdio: "ignore" });
       console.log(child.pid);
       setInterval(() => {}, 1000);`,
    );
    parent = spawn(process.execPath, [join(dir, "parent.mjs")], {
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const [line] = (await once(parent.stdout as NodeJS.ReadableStream, "data")) as [Buffer];
    childPid = Number(line.toString().trim());
    const found = processesUnder(dir);
    assert.deepEqual(found.map((row) => row.pid).sort(), [parent.pid, childPid].sort());
    const started = Date.now();
    stopProcessesUnder(dir);
    assert.ok(Date.now() - started >= TERM_GRACE_MS, "the child needed SIGKILL after the grace");
    assert.deepEqual(stillRunning(found), [], "a process from the directory is still running");
  } finally {
    // Independent of discovery, which is what this test checks.
    parent?.kill("SIGKILL");
    if (childPid !== undefined) killIfCommandHas(childPid, marker);
    rmSync(dir, { recursive: true, force: true });
  }
});
